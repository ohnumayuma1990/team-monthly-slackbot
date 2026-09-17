/**
 * Entry types for team monthly submission
 */
export type SubmissionType = 'individual' | 'groupwork' | 'observer';

export interface IndividualData {
  name: string;
  recentStatus: string;
  workloadLanding: string;
  interviewPreference: string;
}

export interface GroupworkData {
  name: string;
  gwComment: string;
}

export interface ObserverData {
  name: string;
  generalReview: string;
}

export interface MonthlySubmission {
  targetMonth: string; // e.g., '26_9月'
  type: SubmissionType;
  individual?: IndividualData;
  groupwork?: GroupworkData;
  observer?: ObserverData;
}

export interface UnsubmittedMember {
  name: string;
  slackUserId?: string;
  missingIndividual: boolean;
  missingGroupwork: boolean;
}

export interface SectionRange {
  startRow: number;
  endRow: number;
}

export interface SheetStructure {
  sheetName: string;
  individualSection: SectionRange;
  groupworkSection: SectionRange;
  observerSection: SectionRange;
  memberRows: Map<string, number>; // Normalized Name -> Row number
}

export interface WeeklyReportCheckResult {
  weekLabel: string;
  submitted: string[];
  unsubmitted: string[];
  totalMembers: number;
}

export interface GSessionLoginStatus {
  name: string;
  lastLoginDate?: string;
  daysSinceLastLogin?: number;
  isInactive: boolean; // >= 7 days
}

export interface WeeklyCheckSummary {
  checkedAt: Date;
  weeklyReport: WeeklyReportCheckResult;
  gSession: {
    inactiveMembers: GSessionLoginStatus[];
    activeMembers: GSessionLoginStatus[];
  };
}

export interface ProjectReportDetail {
  properName: string;
  endUser: string;
  prjDetail: string;
}

export interface WeeklyReportContent {
  staffId: number;
  staffName: string;
  impression: string;
  weekUptime?: string | number;
  projects: ProjectReportDetail[];
}

export interface WeeklySummaryResult {
  weekLabel: string;
  summaryText: string;
  submittedCount: number;
  totalMembers: number;
}

export interface GSessionScheduleEvent {
  id: string;
  title: string;
}

export interface GSessionScheduleDay {
  dateStr: string; // '20260918'
  formattedDate: string; // '09/18(金)'
  holiday?: string; // '敬老の日'
  events: GSessionScheduleEvent[];
}

export interface TeamMemberConfig {
  name: string;
  slackId?: string;
  email?: string;
  staffNum?: string;
  role?: 'member' | 'manager';
}

export interface GmailIncomingMessage {
  id: string;
  threadId?: string;
  date: string;
  from: string;
  to?: string;
  subject: string;
  body: string;
  snippet?: string;
}

export interface AttendanceRecord {
  memberName: string;
  slackUserId?: string;
  date: string;
  leaveType: string; // '全休', '午前休', '午後休', '遅刻', '早退', '在宅', etc.
  isSameDay: boolean;
  reason?: string;
  rawSubject: string;
}

export interface AllHandsAnnouncement {
  subject: string;
  from: string;
  date: string;
  summary: string;
  keyPoints: string[];
  deadline?: string;
  rawBody?: string;
}

export interface PydioAttendanceFile {
  filename: string;
  bytesize?: string;
  modifTime?: string;
}

export interface AttendanceSubmissionStatus {
  member: TeamMemberConfig;
  submitted: boolean;
  filename?: string;
  bytesize?: string;
  modifTime?: string;
}

export interface AttendanceCheckResult {
  targetFolder: string;
  targetMonth: string; // e.g. '202608'
  fiscalYear: string; // e.g. '2026年度'
  isFirstTwoBusinessDays: boolean;
  isMonthEndBusinessDays: boolean;
  submitted: AttendanceSubmissionStatus[];
  unsubmitted: AttendanceSubmissionStatus[];
  totalMembers: number;
}

