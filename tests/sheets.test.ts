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
    expect(normalizeName('山田 太郎')).toBe('山田太郎');
    expect(normalizeName('山田　太郎')).toBe('山田太郎');
    expect(normalizeName(' 山田  太郎 ')).toBe('山田太郎');
    expect(normalizeName('Alice Smith')).toBe('alicesmith');
  });

  it('matches names accurately despite space discrepancies', () => {
    expect(isNameMatch('山田 太郎', '山田太郎')).toBe(true);
    expect(isNameMatch('山田', '山田太郎')).toBe(true);
    expect(isNameMatch('田中　太郎', '田中 太郎')).toBe(true);
    expect(isNameMatch('佐藤 次郎', '鈴木 次郎')).toBe(false);
  });

  it('formats default month properly', () => {
    const testDate = new Date(2026, 8, 1); // September (month index 8) 2026
    expect(formatDefaultMonth(testDate)).toBe('26_9月');
  });

  it('parses real team spreadsheet structure accurately', () => {
    const realSheetRows = [
      [
        'グループワークメンバー',
        '',
        '近況＋困ってること→テキシコーに当てはめると',
        '稼働状況（今月の稼働着地予想 ex:140h）',
        '面談希望 対面 or WEB or 不要',
      ],
      ['A', '佐藤　次郎', '近況テスト', '140h', '不要'],
      ['B', '鈴木　三郎', '', '', ''],
      ['グループワーク', '', '', '', ''],
      ['A', '佐藤　次郎', '教える側の感じたポイント：テスト', '', ''],
      ['', '本日のまとめ', '', '', ''],
      ['', '高橋', 'まとめコメント', '', ''],
    ];

    const parsed = parseMonthlySheet('26_8月', realSheetRows);
    expect(parsed.individualRows.length).toBe(2);
    expect(parsed.individualRows[0].name).toBe('佐藤　次郎');
    expect(parsed.individualRows[0].recentStatus).toBe('近況テスト');
    expect(parsed.individualRows[0].workloadLanding).toBe('140h');
    expect(parsed.individualRows[0].interviewPreference).toBe('不要');

    expect(parsed.groupworkRows.length).toBe(1);
    expect(parsed.groupworkRows[0].name).toBe('佐藤　次郎');
    expect(parsed.groupworkRows[0].comment).toBe(
      '教える側の感じたポイント：テスト'
    );

    expect(parsed.observerRows.length).toBe(1);
    expect(parsed.observerRows[0].name).toBe('高橋');
    expect(parsed.observerRows[0].review).toBe('まとめコメント');
  });

  it('parses raw grid data into individual, groupwork, and observer sections', () => {
    const mockRows = [
      ['No', '氏名', '近況・困りごと', '稼働着地', '面談希望'], // Header
      ['1', '山田 太郎', '順調に進んでいます', '160h', '希望なし'],
      ['2', '佐藤 次郎', '', '150h', '希望あり（月内）'],
      ['', 'グループワーク振り返り', '', '', ''], // Section separator
      ['1', '山田 太郎', '教わる側として質問をたくさんしました', '', ''],
      ['2', '佐藤 次郎', '', '', ''],
      ['', '本日のまとめ・総評', '', '', ''], // Observer section
      ['1', '山田 太郎', 'チーム全体として活発な議論ができました。', '', ''],
    ];

    const parsed = parseMonthlySheet('26_9月', mockRows);

    expect(parsed.sheetName).toBe('26_9月');
    expect(parsed.individualRows.length).toBe(2);
    expect(parsed.individualRows[0].name).toBe('山田 太郎');
    expect(parsed.individualRows[0].recentStatus).toBe('順調に進んでいます');
    expect(parsed.individualRows[1].recentStatus).toBe('');

    expect(parsed.groupworkRows.length).toBe(2);
    expect(parsed.groupworkRows[0].name).toBe('山田 太郎');
    expect(parsed.groupworkRows[0].comment).toBe(
      '教わる側として質問をたくさんしました'
    );

    expect(parsed.observerRows.length).toBe(1);
    expect(parsed.observerRows[0].name).toBe('山田 太郎');
  });
});

describe('SheetsService', () => {
  afterEach(() => {
    setMockSheetsClient(null);
  });

  it('correctly detects unsubmitted members', async () => {
    const mockRows = [
      ['No', '氏名', '近況・困りごと', '稼働着地', '面談希望'],
      ['1', '山田 太郎', '完了済みの近況', '160h', '希望なし'],
      ['2', '未入力 太郎', '', '', ''],
      ['', 'グループワーク振り返り', '', '', ''],
      ['1', '山田 太郎', '', '', ''], // GW未入力
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

    const yamada = unsubmitted.find((u) => u.name.includes('山田'));
    expect(yamada).toBeDefined();
    expect(yamada?.missingIndividual).toBe(false);
    expect(yamada?.missingGroupwork).toBe(true);

    const taro = unsubmitted.find((u) => u.name.includes('未入力'));
    expect(taro).toBeDefined();
    expect(taro?.missingIndividual).toBe(true);
    expect(taro?.missingGroupwork).toBe(true);
  });

  it('updates an individual row with new values', async () => {
    const mockRows = [
      ['No', '氏名', '近況・困りごと', '稼働着地', '面談希望'],
      ['1', '山田 太郎', '古い近況', '140h', '希望なし'],
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
        name: '山田 太郎',
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
