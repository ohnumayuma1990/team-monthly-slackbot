import { GeminiService, formatMarkdownForSlack } from '../src/ai/gemini';

describe('GeminiService', () => {
  it('detects if API key is configured', () => {
    const unconfigured = new GeminiService('');
    expect(unconfigured.isConfigured()).toBe(false);

    const configured = new GeminiService('test-key', 'gemini-2.5-flash');
    expect(configured.isConfigured()).toBe(true);
  });

  it('throws error when generateText is called without api key', async () => {
    const service = new GeminiService('');
    await expect(service.generateText('hello')).rejects.toThrow(
      'GEMINI_API_KEY is not configured in environment.'
    );
  });
});

describe('formatMarkdownForSlack', () => {
  it('converts markdown headers to bold text', () => {
    expect(formatMarkdownForSlack('### 1. 💡 全体概況・トピック')).toBe(
      '*1. 💡 全体概況・トピック*'
    );
    expect(formatMarkdownForSlack('## 2. ⚠️ 要フォロー')).toBe(
      '*2. ⚠️ 要フォロー*'
    );
  });

  it('converts double asterisk bold to single asterisk bold for Slack mrkdwn', () => {
    expect(formatMarkdownForSlack('**状況** : テスト')).toBe('*状況* : テスト');
  });

  it('converts horizontal rules to decorative line', () => {
    expect(formatMarkdownForSlack('---')).toBe('━━━━━━━━━━━━━━━━━━━━━━');
    expect(formatMarkdownForSlack('***')).toBe('━━━━━━━━━━━━━━━━━━━━━━');
  });

  it('converts markdown list bullets to clean bullets', () => {
    const input = '* 項目1\n  * 項目2\n- 項目3';
    const expected = '・項目1\n  ・項目2\n・項目3';
    expect(formatMarkdownForSlack(input)).toBe(expected);
  });

  it('converts markdown links to Slack links', () => {
    expect(formatMarkdownForSlack('[詳細](https://example.com)')).toBe(
      '<https://example.com|詳細>'
    );
  });

  it('handles empty strings gracefully', () => {
    expect(formatMarkdownForSlack('')).toBe('');
  });
});
