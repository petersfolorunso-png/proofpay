import { config } from "./config.ts";

/** Pluggable LLM provider. Every call must return parsed JSON or throw. */
export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generateJson(system: string, user: string): Promise<unknown>;
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly model: string;
  private apiKey: string;
  private timeoutMs: number;
  constructor(apiKey: string, model: string, timeoutMs = 20_000) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async generateJson(system: string, user: string): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
            signal: AbortSignal.timeout(this.timeoutMs),
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: [{ role: "user", parts: [{ text: user }] }],
              generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 2048 },
            }),
          },
        );
        if (res.status === 429 || res.status >= 500) throw new Error(`gemini http ${res.status}`);
        if (!res.ok) throw Object.assign(new Error(`gemini http ${res.status}`), { fatal: true });
        const body: any = await res.json();
        const text: string = (body?.candidates?.[0]?.content?.parts ?? [])
          .map((p: any) => p.text ?? "")
          .join("");
        return JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim());
      } catch (e: any) {
        lastErr = e;
        if (e?.fatal) break;
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

/** Deterministic mode: no model. Callers fall back to rule-based logic. */
export function makeProvider(): LLMProvider | null {
  if (config.llmProvider === "gemini" && config.geminiApiKey) {
    return new GeminiProvider(config.geminiApiKey, config.geminiModel);
  }
  return null;
}
