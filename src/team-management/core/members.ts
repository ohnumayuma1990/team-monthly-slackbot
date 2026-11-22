import { TeamMemberConfig } from '../../types';
import { getTeamMembers, getAllMembers } from '../../config/members';
import { normalizeName } from '../../sheets/parser';
import { TeamManagementError } from './types';

const FORBIDDEN_PUBLIC_PREFIXES = ['NEXT_PUBLIC_', 'NUXT_PUBLIC_', 'VITE_'];
const SENSITIVE_KEY_PATTERNS = [
  'WEEKLY_REPORT_USERNAME',
  'WEEKLY_REPORT_PASSWORD',
  'WEEKLY_REPORT_USER',
  'WEEKLY_REPORT_PASS',
  'GSESSION_USERNAME',
  'GSESSION_PASSWORD',
  'GSESSION_USER',
  'GSESSION_PASS',
  'GEMINI_API_KEY',
  'TEAM_MEMBERS_CONFIG',
  'REMINDER_SECRET_TOKEN',
  'TEAM_MANAGEMENT_CRON_SECRET',
  'EXTERNAL_AGENT_CLIENTS_CONFIG',
];

/**
 * Ensures sensitive secrets or member PII are never exposed via client-public environment variable prefixes.
 */
export function assertNoPublicSecretEnvVars(
  env: NodeJS.ProcessEnv = process.env
): void {
  for (const key of Object.keys(env)) {
    const hasPublicPrefix = FORBIDDEN_PUBLIC_PREFIXES.some((prefix) =>
      key.startsWith(prefix)
    );
    if (!hasPublicPrefix) continue;

    const exposesSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) =>
      key.toUpperCase().includes(pattern)
    );
    if (exposesSensitive && env[key]) {
      throw new TeamManagementError(
        'PUBLIC_ENV_SECRET_LEAK_DETECTED',
        `Security violation: sensitive variable "${key}" must not use a client-exposed public prefix.`
      );
    }
  }
}

/**
 * Matches a candidate record against configured team members using strict priority:
 * 1. Exact 6-digit staffNum match
 * 2. Normalized full name exact match
 * 3. Optional prefix match ONLY if unambiguous (exactly 1 member matches)
 */
export function matchConfiguredMember(
  candidate: {
    staffNum?: string | null;
    name?: string | null;
  },
  members: TeamMemberConfig[] = getTeamMembers()
): TeamMemberConfig | undefined {
  const cleanStaffNum = (candidate.staffNum || '').trim();
  if (cleanStaffNum) {
    const byStaffNum = members.find(
      (m) => m.staffNum && m.staffNum.trim() === cleanStaffNum
    );
    if (byStaffNum) return byStaffNum;
  }

  const normCandidate = normalizeName(candidate.name || '');
  if (!normCandidate) return undefined;

  // Exact normalized full-name match
  const exactMatch = members.find(
    (m) => normalizeName(m.name) === normCandidate
  );
  if (exactMatch) return exactMatch;

  // Unambiguous prefix match (prevents false positives when two members share the same surname)
  if (normCandidate.length >= 2) {
    const prefixMatches = members.filter((m) => {
      const normM = normalizeName(m.name);
      return (
        normM.length >= 2 &&
        (normM.startsWith(normCandidate) || normCandidate.startsWith(normM))
      );
    });
    if (prefixMatches.length === 1) {
      return prefixMatches[0];
    }
  }

  return undefined;
}

export { getTeamMembers, getAllMembers, normalizeName };
