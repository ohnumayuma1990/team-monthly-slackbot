import { getSheetsClient } from './client';
import {
  parseMonthlySheet,
  normalizeName,
  isNameMatch,
  ParsedSheetData,
} from './parser';
import { MonthlySubmission, UnsubmittedMember } from '../types';

export class SheetsService {
  private spreadsheetId: string;

  constructor(spreadsheetId?: string) {
    this.spreadsheetId = spreadsheetId || process.env.SPREADSHEET_ID || '';
    if (!this.spreadsheetId) {
      console.warn('Warning: SPREADSHEET_ID is not configured in environment.');
    }
  }

  /**
   * Fetches raw rows from the specified sheet tab.
   */
  async getSheetData(sheetName: string): Promise<string[][]> {
    const sheets = getSheetsClient();
    const range = `${sheetName}!A1:Z100`;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range,
    });

    return (response.data.values as string[][]) || [];
  }

  /**
   * Parses sheet structure for target month.
   */
  async getParsedSheet(sheetName: string): Promise<ParsedSheetData> {
    const rows = await this.getSheetData(sheetName);
    return parseMonthlySheet(sheetName, rows);
  }

  /**
   * Submits monthly data based on submission type.
   */
  async submitData(
    submission: MonthlySubmission
  ): Promise<{ success: boolean; message: string; updatedRow?: number }> {
    const parsed = await this.getParsedSheet(submission.targetMonth);
    const sheets = getSheetsClient();

    if (submission.type === 'individual' && submission.individual) {
      const { name, recentStatus, workloadLanding, interviewPreference } =
        submission.individual;
      const targetRow = parsed.individualRows.find((r) =>
        isNameMatch(r.name, name)
      );

      if (!targetRow) {
        return {
          success: false,
          message: `シート「${submission.targetMonth}」の個人セクションに「${name}」が見つかりませんでした。`,
        };
      }

      // Columns: C (col 3), D (col 4), E (col 5)
      const range = `${submission.targetMonth}!C${targetRow.rowNumber}:E${targetRow.rowNumber}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[recentStatus, workloadLanding, interviewPreference]],
        },
      });

      return {
        success: true,
        message: `「${targetRow.name}」さんの個人近況をスプレッドシート（${submission.targetMonth}、${targetRow.rowNumber}行目）に反映しました！`,
        updatedRow: targetRow.rowNumber,
      };
    } else if (submission.type === 'groupwork' && submission.groupwork) {
      const { name, gwComment } = submission.groupwork;
      const targetRow = parsed.groupworkRows.find((r) =>
        isNameMatch(r.name, name)
      );

      if (!targetRow) {
        return {
          success: false,
          message: `シート「${submission.targetMonth}」のグループワークセクションに「${name}」が見つかりませんでした。`,
        };
      }

      // Column C (col 3)
      const range = `${submission.targetMonth}!C${targetRow.rowNumber}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[gwComment]],
        },
      });

      return {
        success: true,
        message: `「${targetRow.name}」さんのGWコメントをスプレッドシート（${submission.targetMonth}、${targetRow.rowNumber}行目）に反映しました！`,
        updatedRow: targetRow.rowNumber,
      };
    } else if (submission.type === 'observer' && submission.observer) {
      const { name, generalReview } = submission.observer;
      const targetRow = parsed.observerRows.find((r) =>
        isNameMatch(r.name, name)
      );

      if (!targetRow) {
        return {
          success: false,
          message: `シート「${submission.targetMonth}」の総評セクションに「${name}」が見つかりませんでした。`,
        };
      }

      // Column C (col 3)
      const range = `${submission.targetMonth}!C${targetRow.rowNumber}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[generalReview]],
        },
      });

      return {
        success: true,
        message: `「${targetRow.name}」さんの総評をスプレッドシート（${submission.targetMonth}、${targetRow.rowNumber}行目）に反映しました！`,
        updatedRow: targetRow.rowNumber,
      };
    }

    return {
      success: false,
      message: '入力種別が不正です。',
    };
  }

  /**
   * Scans monthly sheet and identifies members who have not filled in their recent status or GW comments.
   */
  async getUnsubmittedMembers(sheetName: string): Promise<UnsubmittedMember[]> {
    const parsed = await this.getParsedSheet(sheetName);
    const unsubmittedMap = new Map<string, UnsubmittedMember>();

    // Check individual section
    for (const row of parsed.individualRows) {
      const isStatusEmpty = !row.recentStatus || row.recentStatus.trim() === '';
      if (isStatusEmpty) {
        const key = normalizeName(row.name);
        unsubmittedMap.set(key, {
          name: row.name,
          missingIndividual: true,
          missingGroupwork: false,
        });
      }
    }

    // Check groupwork section
    for (const row of parsed.groupworkRows) {
      const isCommentEmpty = !row.comment || row.comment.trim() === '';
      if (isCommentEmpty) {
        const key = normalizeName(row.name);
        const existing = unsubmittedMap.get(key);
        if (existing) {
          existing.missingGroupwork = true;
        } else {
          unsubmittedMap.set(key, {
            name: row.name,
            missingIndividual: false,
            missingGroupwork: true,
          });
        }
      }
    }

    return Array.from(unsubmittedMap.values());
  }
}
