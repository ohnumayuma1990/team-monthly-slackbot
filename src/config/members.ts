import { TeamMemberConfig } from '../types';
import { isNameMatch } from '../sheets/parser';

export const DEFAULT_TEAM_MEMBERS: TeamMemberConfig[] = [
  {
    name: '小川　智矢',
    slackId: 'U0AQRJZK004',
    email: 'tomoya.ogawa@poweredge.co.jp',
    staffNum: '000156',
    role: 'member',
  },
  {
    name: '小紫　広介',
    slackId: 'U0AQF8WCPK5',
    staffNum: '000257',
    role: 'member',
  },
  {
    name: '朝岡　拓人',
    slackId: 'U0AQ6QH94AK',
    staffNum: '000320',
    role: 'member',
  },
  {
    name: '齋藤　宏行',
    slackId: 'U0AQAQYAKMZ',
    staffNum: '000354',
    role: 'member',
  },
  {
    name: '小林　弘和',
    slackId: 'U0AQSFFV760',
    staffNum: '000425',
    role: 'member',
  },
  {
    name: '川上　慶太',
    slackId: 'U0AQ77705CP',
    staffNum: '000526',
    role: 'member',
  },
  {
    name: '長谷川　明莉',
    slackId: 'U0AQ6PUM0LF',
    staffNum: '000535',
    role: 'member',
  },
  {
    name: '石割　朝比',
    slackId: 'U0AQF05E4KY',
    staffNum: '000548',
    role: 'member',
  },
  {
    name: '尾崎　巧真',
    slackId: 'U0AR1HG1EJV',
    staffNum: '000584',
    role: 'member',
  },
  {
    name: '小倉　拓未',
    slackId: 'U0AQHMZ7V34',
    staffNum: '000595',
    role: 'member',
  },
];

export const DEFAULT_MANAGER: TeamMemberConfig = {
  name: '大沼　佑麻',
  slackId: 'U0AQGV96Q4S',
  email: 't-ohnuma@poweredge.co.jp',
  staffNum: '000100',
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
  if (!members.some((m) => isNameMatch(m.name, manager.name))) {
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
        const found = parsed.find(
          (m) =>
            m.role === 'manager' ||
            isNameMatch(m.name, '大沼') ||
            m.slackId === 'U0AQGV96Q4S'
        );
        if (found) return found;
      }
    } catch {
      // fallback
    }
  }

  const managerSlackId =
    process.env.MANAGER_SLACK_USER_ID || DEFAULT_MANAGER.slackId;
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
