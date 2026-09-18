import { TeamMemberConfig } from '../types';
import { isNameMatch } from '../sheets/parser';

export const DEFAULT_TEAM_MEMBERS: TeamMemberConfig[] = [];

export const DEFAULT_MANAGER: TeamMemberConfig = {
  name: 'マネージャー',
  slackId: '',
  role: 'manager',
};

/**
 * Loads configured team members from TEAM_MEMBERS_CONFIG environment variable (JSON)
 * or falls back to DEFAULT_TEAM_MEMBERS.
 */
export function getTeamMembers(): TeamMemberConfig[] {
  const envConfig = process.env.TEAM_MEMBERS_CONFIG;
  if (envConfig) {
    try {
      const parsed = JSON.parse(envConfig);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter((m) => m.role !== 'manager');
      }
    } catch (e) {
      console.warn('Failed to parse TEAM_MEMBERS_CONFIG env var:', e);
    }
  }
  return [...DEFAULT_TEAM_MEMBERS];
}

/**
 * Returns all members including the manager.
 */
export function getAllMembers(): TeamMemberConfig[] {
  const members = getTeamMembers();
  const manager = getManagerConfig();
  if (manager.name && !members.some((m) => isNameMatch(m.name, manager.name))) {
    return [...members, manager];
  }
  return members;
}

/**
 * Returns the manager configuration.
 */
export function getManagerConfig(): TeamMemberConfig {
  const envConfig = process.env.TEAM_MEMBERS_CONFIG;
  if (envConfig) {
    try {
      const parsed = JSON.parse(envConfig);
      if (Array.isArray(parsed)) {
        const found = parsed.find((m) => m.role === 'manager');
        if (found) {
          return {
            ...found,
            slackId: process.env.MANAGER_SLACK_USER_ID || found.slackId || '',
          };
        }
      }
    } catch {
      // fallback
    }
  }

  const managerSlackId =
    process.env.MANAGER_SLACK_USER_ID || DEFAULT_MANAGER.slackId || '';
  return {
    ...DEFAULT_MANAGER,
    slackId: managerSlackId,
  };
}

/**
 * Finds a team member by name (fuzzy matching spaces).
 */
export function findMemberByName(name: string): TeamMemberConfig | undefined {
  if (!name) return undefined;
  const all = getAllMembers();
  for (const m of all) {
    if (isNameMatch(m.name, name)) {
      return m;
    }
  }
  return undefined;
}

/**
 * Finds a team member by email.
 */
export function findMemberByEmail(email: string): TeamMemberConfig | undefined {
  if (!email) return undefined;
  const cleanEmail = email.toLowerCase().trim();
  const all = getAllMembers();
  return all.find(
    (m) => m.email && m.email.toLowerCase().trim() === cleanEmail
  );
}

/**
 * Gets Slack mention string (<@U12345> or fallback name) for a person.
 */
export function getSlackMention(name: string): string {
  const member = findMemberByName(name);
  if (member?.slackId) {
    return `<@${member.slackId}>`;
  }
  // Check backward-compatible MEMBER_SLACK_MAPPING
  const mappingJson = process.env.MEMBER_SLACK_MAPPING;
  if (mappingJson) {
    try {
      const parsed = JSON.parse(mappingJson);
      for (const [mName, slackId] of Object.entries(parsed)) {
        if (isNameMatch(mName, name)) {
          return `<@${slackId}>`;
        }
      }
    } catch {
      // ignore
    }
  }
  return `${name}さん`;
}

/**
 * Gets the manager Slack user ID.
 */
export function getManagerSlackId(): string {
  return getManagerConfig().slackId || DEFAULT_MANAGER.slackId!;
}
