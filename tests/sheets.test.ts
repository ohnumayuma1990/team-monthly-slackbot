/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  normalizeName,
  isNameMatch,
  formatDefaultMonth,
  parseMonthlySheet,
} from '../src/sheets/parser';
import { SheetsService } from '../src/sheets/service';
import { setMockSheetsClient } from '../src/sheets/client';

describe('Sheets Parser & Name Normalization', () => {
  it('normalizes names with various spaces and formats', () => {
    expect(normalizeName('大沼 佑磨')).toBe('大沼佑磨');
    expect(normalizeName('大沼　佑磨')).toBe('大沼佑磨');
    expect(normalizeName(' 大沼  佑磨 ')).toBe('大沼佑磨');
    expect(normalizeName('Alice Smith')).toBe('alicesmith');
  });

  it('matches names accurately despite space discrepancies', () => {
    expect(isNameMatch('大沼 佑磨', '大沼佑磨')).toBe(true);
    expect(isNameMatch('田中　太郎', '田中 太郎')).toBe(true);
    expect(isNameMatch('佐藤 次郎', '鈴木 次郎')).toBe(false);
  });

  it('formats default month properly', () => {
    const testDate = new Date(2026, 8, 1); // September (month index 8) 2026
    expect(formatDefaultMonth(testDate)).toBe('26_9月');
  });

  it('parses raw grid data into individual, groupwork, and observer sections', () => {
    const mockRows = [
      ['No', '氏名', '近況・困りごと', '稼働着地', '面談希望'], // Header
      ['1', '大沼 佑磨', '順調に進んでいます', '160h', '希望なし'],
      ['2', '山田 太郎', '', '150h', '希望あり（月内）'],
      ['', 'グループワーク振り返り', '', '', ''], // Section separator
      ['1', '大沼 佑磨', '教わる側として質問をたくさんしました', '', ''],
      ['2', '山田 太郎', '', '', ''],
      ['', '本日のまとめ・総評', '', '', ''], // Observer section
      ['1', '大沼 佑磨', 'チーム全体として活発な議論ができました。', '', ''],
    ];

    const parsed = parseMonthlySheet('26_9月', mockRows);

    expect(parsed.sheetName).toBe('26_9月');
    expect(parsed.individualRows.length).toBe(2);
    expect(parsed.individualRows[0].name).toBe('大沼 佑磨');
    expect(parsed.individualRows[0].recentStatus).toBe('順調に進んでいます');
    expect(parsed.individualRows[1].recentStatus).toBe('');

    expect(parsed.groupworkRows.length).toBe(2);
    expect(parsed.groupworkRows[0].name).toBe('大沼 佑磨');
    expect(parsed.groupworkRows[0].comment).toBe(
      '教わる側として質問をたくさんしました'
    );

    expect(parsed.observerRows.length).toBe(1);
    expect(parsed.observerRows[0].name).toBe('大沼 佑磨');
  });
});

describe('SheetsService', () => {
  afterEach(() => {
    setMockSheetsClient(null);
  });

  it('correctly detects unsubmitted members', async () => {
    const mockRows = [
      ['No', '氏名', '近況・困りごと', '稼働着地', '面談希望'],
      ['1', '大沼 佑磨', '完了済みの近況', '160h', '希望なし'],
      ['2', '未入力 太郎', '', '', ''],
      ['', 'グループワーク振り返り', '', '', ''],
      ['1', '大沼 佑磨', '', '', ''], // GW未入力
      ['2', '未入力 太郎', '', '', ''], // 両方未入力
    ];

    const mockSheetsClient: any = {
      spreadsheets: {
        values: {
          get: jest.fn().mockResolvedValue({
            data: { values: mockRows },
          }),
          update: jest.fn().mockResolvedValue({ data: {} }),
        },
      },
    };

    setMockSheetsClient(mockSheetsClient);

    const service = new SheetsService('dummy-spreadsheet-id');
    const unsubmitted = await service.getUnsubmittedMembers('26_9月');

    expect(unsubmitted.length).toBe(2);

    const onuma = unsubmitted.find((u) => u.name.includes('大沼'));
    expect(onuma).toBeDefined();
    expect(onuma?.missingIndividual).toBe(false);
    expect(onuma?.missingGroupwork).toBe(true);

    const taro = unsubmitted.find((u) => u.name.includes('未入力'));
    expect(taro).toBeDefined();
    expect(taro?.missingIndividual).toBe(true);
    expect(taro?.missingGroupwork).toBe(true);
  });

  it('updates an individual row with new values', async () => {
    const mockRows = [
      ['No', '氏名', '近況・困りごと', '稼働着地', '面談希望'],
      ['1', '大沼 佑磨', '古い近況', '140h', '希望なし'],
    ];

    const updateMock = jest.fn().mockResolvedValue({ data: {} });
    const mockSheetsClient: any = {
      spreadsheets: {
        values: {
          get: jest.fn().mockResolvedValue({ data: { values: mockRows } }),
          update: updateMock,
        },
      },
    };

    setMockSheetsClient(mockSheetsClient);

    const service = new SheetsService('dummy-spreadsheet-id');
    const result = await service.submitData({
      targetMonth: '26_9月',
      type: 'individual',
      individual: {
        name: '大沼 佑磨',
        recentStatus: '新しい近況です',
        workloadLanding: '160h',
        interviewPreference: '希望あり（月内）',
      },
    });

    expect(result.success).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        range: '26_9月!C2:E2',
        requestBody: {
          values: [['新しい近況です', '160h', '希望あり（月内）']],
        },
      })
    );
  });
});
