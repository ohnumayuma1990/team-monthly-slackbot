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
  return normA === normB;
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
 * Col A = Index 0 (No or Category)
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

    // Check for section headers in colA or colB
    const combinedHeader = `${colA} ${colB}`.toLowerCase();
    if (
      combinedHeader.includes('個人') ||
      combinedHeader.includes('近況') ||
      combinedHeader.includes('individual')
    ) {
      currentSection = 'individual';
      continue;
    } else if (
      combinedHeader.includes('グループワーク') ||
      combinedHeader.includes('gw') ||
      combinedHeader.includes('group')
    ) {
      currentSection = 'groupwork';
      continue;
    } else if (
      combinedHeader.includes('オブザーバー') ||
      combinedHeader.includes('まとめ') ||
      combinedHeader.includes('総評') ||
      combinedHeader.includes('observer')
    ) {
      currentSection = 'observer';
      continue;
    }

    // Skip table header rows (e.g., "氏名", "近況", "名前", etc.)
    if (
      colB === '氏名' ||
      colB === '名前' ||
      colB === '氏　名' ||
      colB === 'Name'
    ) {
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
