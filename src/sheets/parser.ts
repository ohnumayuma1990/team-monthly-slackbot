/**
 * Normalizes a member name for comparison (removes all whitespace, converts fullwidth to halfwidth if applicable).
 */
export function normalizeName(name: string): string {
  if (!name) return '';
  return name
    .replace(/[\s\u3000]+/g, '') // remove all half-width and full-width whitespace
    .trim()
    .toLowerCase();
}

/**
 * Checks if two names match after normalization.
 */
export function isNameMatch(nameA: string, nameB: string): boolean {
  const normA = normalizeName(nameA);
  const normB = normalizeName(nameB);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  // Support last-name or partial match (e.g., '大沼' matches '大沼佑磨')
  if (normA.length >= 2 && normB.length >= 2) {
    if (normA.startsWith(normB) || normB.startsWith(normA)) {
      return true;
    }
  }
  return false;
}

export interface ParsedSheetData {
  sheetName: string;
  individualRows: {
    rowNumber: number;
    name: string;
    recentStatus: string;
    workloadLanding: string;
    interviewPreference: string;
  }[];
  groupworkRows: { rowNumber: number; name: string; comment: string }[];
  observerRows: { rowNumber: number; name: string; review: string }[];
}

/**
 * Parses raw grid values of a monthly sheet into structured section data.
 * Assumes 1-indexed row numbers corresponding to Google Sheets rows.
 *
 * Columns convention:
 * Col A = Index 0 (No or Category / Group)
 * Col B = Index 1 (Name)
 * Col C = Index 2 (Status / GW Comment / Review)
 * Col D = Index 3 (Workload Landing)
 * Col E = Index 4 (Interview Preference)
 */
export function parseMonthlySheet(
  sheetName: string,
  rows: string[][]
): ParsedSheetData {
  const result: ParsedSheetData = {
    sheetName,
    individualRows: [],
    groupworkRows: [],
    observerRows: [],
  };

  type CurrentSection = 'none' | 'individual' | 'groupwork' | 'observer';
  let currentSection: CurrentSection = 'none';

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 1; // 1-indexed for Sheets
    const row = rows[i] || [];
    const colA = (row[0] || '').trim();
    const colB = (row[1] || '').trim();
    const colC = (row[2] || '').trim();
    const colD = (row[3] || '').trim();
    const colE = (row[4] || '').trim();

    const rowText = `${colA} ${colB} ${colC} ${colD} ${colE}`.toLowerCase();

    // Check if colB is header-like or empty rather than a member's name
    const isHeaderLikeColB =
      !colB ||
      ['氏名', '名前', '氏　名', 'name'].includes(colB.toLowerCase()) ||
      colB.includes('グループワーク') ||
      colB.includes('まとめ') ||
      colB.includes('総評') ||
      colB.includes('オブザーバー');

    if (isHeaderLikeColB) {
      if (
        rowText.includes('本日のまとめ') ||
        rowText.includes('まとめ') ||
        rowText.includes('オブザーバー') ||
        rowText.includes('総評') ||
        rowText.includes('observer')
      ) {
        currentSection = 'observer';
        continue;
      }

      if (
        (colA.includes('グループワーク') ||
          colB.includes('グループワーク') ||
          rowText.includes('gw')) &&
        !rowText.includes('メンバー') &&
        !rowText.includes('近況')
      ) {
        currentSection = 'groupwork';
        continue;
      }

      if (
        rowText.includes('近況') ||
        rowText.includes('稼働状況') ||
        rowText.includes('稼働') ||
        rowText.includes('面談希望') ||
        rowText.includes('individual')
      ) {
        currentSection = 'individual';
        continue;
      }

      // If it's a table header (e.g. "氏名") or an empty row, skip it
      continue;
    }

    // Process rows having a member name
    if (colB) {
      if (currentSection === 'individual' || currentSection === 'none') {
        result.individualRows.push({
          rowNumber,
          name: colB,
          recentStatus: colC,
          workloadLanding: colD,
          interviewPreference: colE,
        });
      } else if (currentSection === 'groupwork') {
        result.groupworkRows.push({
          rowNumber,
          name: colB,
          comment: colC,
        });
      } else if (currentSection === 'observer') {
        result.observerRows.push({
          rowNumber,
          name: colB,
          review: colC,
        });
      }
    }
  }

  return result;
}

/**
 * Helper to compute default target month name (e.g., '26_9月' for September 2026).
 */
export function formatDefaultMonth(date: Date = new Date()): string {
  const yearStr = String(date.getFullYear()).slice(-2); // '26'
  const month = date.getMonth() + 1; // 1-12
  return `${yearStr}_${month}月`;
}
