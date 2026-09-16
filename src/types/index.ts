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
