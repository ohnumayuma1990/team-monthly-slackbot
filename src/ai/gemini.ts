/**
 * Gemini API client for Google AI Studio (Free Tier)
 * Uses native fetch (Node.js 18+) for maximum stability and zero additional dependencies.
 */
export class GeminiService {
  private apiKey: string;
  private model: string;

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY || '';
    // Default to gemini-2.5-flash which has a stable free tier, or allow override via GEMINI_MODEL
    this.model = model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  }

  /**
   * Checks whether Gemini API is configured.
   */
  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Generates content from text prompt.
   */
  async generateText(
    prompt: string,
    systemInstruction?: string
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is not configured in environment.');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const requestBody: Record<string, unknown> = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
    };

    if (systemInstruction) {
      requestBody.systemInstruction = {
        parts: [{ text: systemInstruction }],
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const candidate = data.candidates?.[0];
    const textPart = candidate?.content?.parts?.[0]?.text;

    return textPart || '';
  }

  /**
   * Optional helper: Generates quick feedback or hints for a member's reported concern.
   */
  async generateConcernHint(
    memberName: string,
    statusText: string
  ): Promise<string> {
    if (!this.isConfigured() || !statusText) return '';

    const systemInstruction =
      'あなたはエンジニアチームの温かいメンターです。メンバーの困りごとや近況に対し、50〜100文字程度で前向きな共感と実践的なアドバイスを1つ返答してください。絵文字を自然に使ってください。';
    const prompt = `メンバー名: ${memberName}\n近況・困りごと: ${statusText}`;

    try {
      return await this.generateText(prompt, systemInstruction);
    } catch (e) {
      console.warn('Gemini hint generation failed:', e);
      return '';
    }
  }

  /**
   * Optional helper: Generates draft of overall meeting review from all members' inputs.
   */
  async generateSummaryDraft(inputsSummary: string): Promise<string> {
    if (!this.isConfigured()) return '';

    const systemInstruction =
      'あなたはチームリーダーのサポートAIです。チームメンバー全員の月次近況やGW振り返りをまとめ、月次定例の総評ドラフト（トピック、好事例、課題、来月の注力ポイント）を箇条書きで分かりやすく整理してください。';

    try {
      return await this.generateText(inputsSummary, systemInstruction);
    } catch (e) {
      console.warn('Gemini summary generation failed:', e);
      return '';
    }
  }
}
