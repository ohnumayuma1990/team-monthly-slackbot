/* eslint-disable @typescript-eslint/no-explicit-any */
import { ReminderService } from '../src/reminder/service';

describe('ReminderService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('maps unsubmitted members to Slack User IDs and formats reminder text', async () => {
    process.env.MEMBER_SLACK_MAPPING = JSON.stringify({
      大沼佑磨: 'U0001',
      未入力太郎: 'U0002',
    });

    const mockSheetsService: any = {
      getUnsubmittedMembers: jest.fn().mockResolvedValue([
        {
          name: '大沼 佑磨',
          missingIndividual: false,
          missingGroupwork: true,
        },
        {
          name: '未入力 太郎',
          missingIndividual: true,
          missingGroupwork: true,
        },
      ]),
    };

    const reminderService = new ReminderService(mockSheetsService);
    const mockPostMessage = jest.fn().mockResolvedValue({ ok: true });
    const mockApp: any = {
      client: {
        chat: {
          postMessage: mockPostMessage,
        },
      },
    };

    const result = await reminderService.sendChannelReminder(
      mockApp,
      'C12345',
      '26_9月'
    );

    expect(result.sent).toBe(true);
    expect(result.unsubmittedCount).toBe(2);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);

    const callArg = mockPostMessage.mock.calls[0][0];
    expect(callArg.channel).toBe('C12345');
    expect(callArg.text).toContain('<@U0001>');
    expect(callArg.text).toContain('<@U0002>');
    expect(callArg.text).toContain('GW振り返り');
    expect(callArg.text).toContain('個人近況');
  });
});
