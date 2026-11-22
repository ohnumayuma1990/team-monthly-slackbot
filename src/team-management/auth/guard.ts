import crypto from 'crypto';
import { IncomingHttpHeaders } from 'http';
import { getManagerConfig } from '../../config/members';
import {
  AccessDeniedError,
  AuthUserContext,
  ExternalAgentClientContext,
  ExternalAgentScope,
  UserRole,
} from '../core/types';

/**
 * Constant-time token comparison using SHA-256 digest + crypto.timingSafeEqual
 * to prevent timing attacks without leaking token lengths.
 */
export function timingSafeTokenEquals(
  actual: string,
  expected: string
): boolean {
  if (!actual || !expected) return false;
  const hashA = crypto.createHash('sha256').update(actual, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function getHeaderString(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  name: string
): string {
  const val = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(val)) return val[0] || '';
  return typeof val === 'string' ? val.trim() : '';
}

function extractBearerToken(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>
): string {
  const auth = getHeaderString(headers, 'authorization');
  if (!auth.toLowerCase().startsWith('bearer ')) return '';
  return auth.slice(7).trim();
}

function getConfiguredAdminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS || '';
  const list = raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const mgr = getManagerConfig();
  if (mgr.email && !list.includes(mgr.email.toLowerCase().trim())) {
    list.push(mgr.email.toLowerCase().trim());
  }
  return list;
}

/**
 * Fail-Closed Admin RBAC Guard for Management Dashboard, Common APIs, and Copilot Agent.
 * - Rejects with 500 if neither TEAM_MANAGEMENT_ADMIN_TOKEN nor ADMIN_EMAILS is configured.
 * - Rejects with 401 if caller provides no authentication credentials.
 * - Rejects with 403 if caller is a general member (`role === 'member'` or non-admin email).
 */
export function requireAdminUser(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>
): AuthUserContext {
  const adminToken = (process.env.TEAM_MANAGEMENT_ADMIN_TOKEN || '').trim();
  const adminEmails = getConfiguredAdminEmails();

  if (!adminToken && adminEmails.length === 0) {
    throw new AccessDeniedError(
      'Admin authentication configuration (TEAM_MANAGEMENT_ADMIN_TOKEN or ADMIN_EMAILS) is missing.',
      500
    );
  }

  const bearer = extractBearerToken(headers);
  const roleHeader = getHeaderString(headers, 'x-user-role').toLowerCase();
  const emailHeader = getHeaderString(headers, 'x-user-email').toLowerCase();
  const userIdHeader = getHeaderString(headers, 'x-user-id') || 'admin-user';

  // If explicit non-admin role is present, deny immediately even if other headers exist
  if (roleHeader === 'member' || roleHeader === 'guest') {
    throw new AccessDeniedError(
      'Access denied: Team Management data is restricted to administrators.',
      403
    );
  }

  if (!bearer && !roleHeader && !emailHeader) {
    throw new AccessDeniedError(
      'Authentication required to access Team Management API.',
      401
    );
  }

  // Case 1: Bearer token authentication
  if (adminToken) {
    if (!bearer || !timingSafeTokenEquals(bearer, adminToken)) {
      // Distinguish between an authenticated general user vs invalid token
      if (emailHeader && !adminEmails.includes(emailHeader)) {
        throw new AccessDeniedError(
          'Access denied: general user cannot access Team Management API.',
          403
        );
      }
      throw new AccessDeniedError('Invalid or missing admin token.', 401);
    }
  }

  // Case 2: If email header is provided and ADMIN_EMAILS is configured, verify membership
  if (emailHeader && adminEmails.length > 0) {
    if (!adminEmails.includes(emailHeader)) {
      throw new AccessDeniedError(
        `Access denied: user "${emailHeader}" is not an authorized administrator.`,
        403
      );
    }
  } else if (!adminToken && adminEmails.length > 0 && !emailHeader) {
    throw new AccessDeniedError(
      'Authenticated administrator email is required.',
      401
    );
  }

  const resolvedRole: UserRole = roleHeader === 'manager' ? 'manager' : 'admin';

  return {
    userId: userIdHeader,
    email: emailHeader || undefined,
    role: resolvedRole,
    isAdmin: true,
  };
}

/**
 * Fail-Closed Cron Authentication Guard for Cloud Scheduler endpoints.
 * Fixes the Fail-Open bug where an unset secret allowed unauthenticated requests.
 */
export function requireCronAuth(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>
): void {
  const expectedSecret = (
    process.env.TEAM_MANAGEMENT_CRON_SECRET ||
    process.env.REMINDER_SECRET_TOKEN ||
    ''
  ).trim();

  if (!expectedSecret) {
    throw new AccessDeniedError(
      'Cron authentication secret (TEAM_MANAGEMENT_CRON_SECRET / REMINDER_SECRET_TOKEN) is not configured.',
      500
    );
  }

  const bearer = extractBearerToken(headers);
  if (!bearer || !timingSafeTokenEquals(bearer, expectedSecret)) {
    throw new AccessDeniedError('Invalid or missing Cron bearer token.', 401);
  }
}

interface ConfiguredExternalClient {
  clientId: string;
  apiKey: string;
  scopes: ExternalAgentScope[];
  rateLimitPerMinute?: number;
}

const externalClientRateBuckets = new Map<string, number[]>();

export function resetExternalAgentRateLimits(): void {
  externalClientRateBuckets.clear();
}

/**
 * Dedicated authentication, scope authorization, and sliding-window rate limiter
 * for external custom apps calling the Team Management Agent API.
 */
export function requireExternalAgentAuth(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  requiredScope: ExternalAgentScope = 'team:read',
  nowMs: number = Date.now()
): ExternalAgentClientContext {
  const rawConfig = (process.env.EXTERNAL_AGENT_CLIENTS_CONFIG || '').trim();
  if (!rawConfig) {
    throw new AccessDeniedError(
      'EXTERNAL_AGENT_CLIENTS_CONFIG is not configured.',
      500
    );
  }

  let clients: ConfiguredExternalClient[] = [];
  try {
    const parsed = JSON.parse(rawConfig);
    if (Array.isArray(parsed)) {
      clients = parsed;
    }
  } catch {
    throw new AccessDeniedError(
      'Failed to parse EXTERNAL_AGENT_CLIENTS_CONFIG.',
      500
    );
  }

  if (clients.length === 0) {
    throw new AccessDeniedError(
      'No external agent clients are configured.',
      500
    );
  }

  const clientId = getHeaderString(headers, 'x-agent-client-id');
  const bearer = extractBearerToken(headers);

  if (!clientId || !bearer) {
    throw new AccessDeniedError(
      'Missing X-Agent-Client-Id or Authorization Bearer token for external agent.',
      401
    );
  }

  const matchedClient = clients.find(
    (c) =>
      c.clientId === clientId &&
      Boolean(c.apiKey) &&
      timingSafeTokenEquals(bearer, c.apiKey)
  );

  if (!matchedClient) {
    throw new AccessDeniedError('Invalid external agent credentials.', 401);
  }

  const scopes: ExternalAgentScope[] = Array.isArray(matchedClient.scopes)
    ? matchedClient.scopes
    : [];
  if (!scopes.includes(requiredScope)) {
    throw new AccessDeniedError(
      `External agent client "${clientId}" lacks required scope "${requiredScope}".`,
      403
    );
  }

  // Sliding-window rate limit check (default 30 requests / 60s)
  const maxPerMin = matchedClient.rateLimitPerMinute ?? 30;
  const windowStart = nowMs - 60000;
  const history = (externalClientRateBuckets.get(clientId) || []).filter(
    (ts) => ts > windowStart
  );

  if (history.length >= maxPerMin) {
    externalClientRateBuckets.set(clientId, history);
    throw new AccessDeniedError(
      `Rate limit exceeded for external agent client "${clientId}" (${maxPerMin}/min).`,
      429
    );
  }

  history.push(nowMs);
  externalClientRateBuckets.set(clientId, history);

  return {
    clientId: matchedClient.clientId,
    scopes,
  };
}
