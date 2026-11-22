/**
 * Team Management Integration - Pure Core Types & Fail-Closed Error Definitions
 * Server-only module: never import in public client bundles.
 */

import {
  GSessionScheduleDay,
  ProjectReportDetail,
  TeamMemberConfig,
  WeeklyReportContent,
} from '../../types';

export type SyncMode = 'STATUS_ONLY' | 'WITH_DETAILS';

export type SyncStatus = 'SUCCESS' | 'PARTIAL_ERROR' | 'FAILED';

export type SyncTriggerType =
  'SCHEDULED_CRON' | 'MANUAL_DASHBOARD' | 'MANUAL_AGENT' | 'EXTERNAL_APP_AGENT';

export type WeeklySubmissionMemberStatus =
  'SUBMITTED' | 'UNSUBMITTED' | 'UNKNOWN';

export type GSessionMemberLoginStatusType =
  'ACTIVE' | 'INACTIVE' | 'NOT_FOUND_IN_GS';

export type UserRole = 'admin' | 'manager' | 'member' | 'guest';

export type ExternalAgentScope = 'team:read' | 'team:sync';

export interface AuthUserContext {
  userId: string;
  email?: string;
  role: UserRole;
  isAdmin: boolean;
}

export interface ExternalAgentClientContext {
  clientId: string;
  scopes: ExternalAgentScope[];
}

export interface DataFreshness {
  source: string;
  fetchedAt: string | null;
  updatedAt: string | null;
  ageMinutes: number | null;
  isStale: boolean;
  lastSyncStatus: SyncStatus | 'NEVER_SYNCED';
  lastSyncError: {
    code: string;
    message: string;
    occurredAt: string;
  } | null;
}

export interface WeeklyMemberStatusRecord {
  staffId: number | null;
  staffNum: string | null;
  staffName: string;
  normalizedName: string;
  status: WeeklySubmissionMemberStatus;
  filingDatetime: string | null;
  wrTargetDateId: number | null;
  hasDetailFetched: boolean;
}

export interface ParsedWeeklyTopResult {
  weekId: string;
  wrTargetDateId: number;
  weekLabel: string;
  submittedCount: number;
  unsubmittedCount: number;
  totalMembers: number;
  members: WeeklyMemberStatusRecord[];
}

export interface WeeklyReportDetailDocument {
  weekId: string;
  wrTargetDateId: number;
  staffId: number;
  staffName: string;
  filingDatetime: string;
  weekUptime: number | null;
  impression: string;
  projects: ProjectReportDetail[];
  externalReadRegistered: boolean;
  source: 'poweredge_weekly_report_detail';
  contentHash: string;
  fetchedAt: string;
  updatedAt: string;
}

export interface FollowUpAlertItem {
  staffName: string;
  severity: 'high' | 'medium' | 'low';
  reason: string;
  recommendedAction: string;
}

export interface MemberHighlightItem {
  staffName: string;
  uptime: number | null;
  summary: string;
}

export interface StructuredWeeklyAiSummary {
  weekId: string;
  weekLabel: string;
  sourceContentHash: string;
  model: string;
  overallSummary: string;
  followUpAlerts: FollowUpAlertItem[];
  memberHighlights: MemberHighlightItem[];
  rawMarkdown: string;
  generatedAt: string;
  updatedAt: string;
}

export interface StrictGSessionMemberLoginRecord {
  staffNum: string | null;
  name: string;
  normalizedName: string;
  lastLoginAt: string | null; // ISO-8601 with +09:00
  rawLastLoginDate: string | null;
  daysSinceLastLogin: number | null;
  status: GSessionMemberLoginStatusType;
}

export interface ParsedGSessionLoginsResult {
  groupSid: string;
  inactiveThresholdDays: number;
  evaluatedAt: string;
  inactiveMembers: StrictGSessionMemberLoginRecord[];
  activeMembers: StrictGSessionMemberLoginRecord[];
  notFoundMembers: StrictGSessionMemberLoginRecord[];
  allMembers: StrictGSessionMemberLoginRecord[];
}

/**
 * Base Fail-Closed error class for Team Management domain.
 */
export class TeamManagementError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 500) {
    super(message);
    this.name = 'TeamManagementError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class ExternalAuthError extends TeamManagementError {
  constructor(system: 'weekly_report' | 'gsession' | 'gemini', detail: string) {
    super(
      `EXTERNAL_AUTH_ERROR_${system.toUpperCase()}`,
      `Authentication failed for ${system}: ${detail}`,
      502
    );
    this.name = 'ExternalAuthError';
  }
}

export class ExternalParseError extends TeamManagementError {
  constructor(system: 'weekly_report' | 'gsession' | 'gemini', detail: string) {
    super(
      `EXTERNAL_PARSE_ERROR_${system.toUpperCase()}`,
      `Failed to parse response from ${system}: ${detail}`,
      502
    );
    this.name = 'ExternalParseError';
  }
}

export class ExternalNetworkError extends TeamManagementError {
  constructor(system: 'weekly_report' | 'gsession' | 'gemini', detail: string) {
    super(
      `EXTERNAL_NETWORK_ERROR_${system.toUpperCase()}`,
      `Network error communicating with ${system}: ${detail}`,
      504
    );
    this.name = 'ExternalNetworkError';
  }
}

export class SyncConflictError extends TeamManagementError {
  public readonly lockedByJobId: string;
  public readonly expiresAt: string;

  constructor(lockedByJobId: string, expiresAt: string) {
    super(
      'SYNC_ALREADY_IN_PROGRESS',
      `Another sync job (${lockedByJobId}) is currently holding the lock until ${expiresAt}.`,
      409
    );
    this.name = 'SyncConflictError';
    this.lockedByJobId = lockedByJobId;
    this.expiresAt = expiresAt;
  }
}

export class ConfirmationRequiredError extends TeamManagementError {
  constructor(message: string) {
    super('CONFIRMATION_REQUIRED', message, 400);
    this.name = 'ConfirmationRequiredError';
  }
}

export class AccessDeniedError extends TeamManagementError {
  constructor(message: string, httpStatus: 401 | 403 | 429 | 500 = 403) {
    const code =
      httpStatus === 401
        ? 'UNAUTHORIZED'
        : httpStatus === 429
          ? 'RATE_LIMIT_EXCEEDED'
          : httpStatus === 500
            ? 'AUTH_CONFIG_MISSING'
            : 'FORBIDDEN_ADMIN_ONLY';
    super(code, message, httpStatus);
    this.name = 'AccessDeniedError';
  }
}

export {
  GSessionScheduleDay,
  ProjectReportDetail,
  TeamMemberConfig,
  WeeklyReportContent,
};
