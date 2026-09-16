import { GeminiService } from '../src/ai/gemini';

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
