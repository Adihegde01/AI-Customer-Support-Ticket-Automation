'use strict';
// Step 2 — AI Ticket Analysis via the Google Gemini API. Interface-compatible
// with ClaudeClient (analyzeTicket / suggestReply), so the provider is chosen
// purely by which API key is configured. Same resilience contract: exponential
// backoff 5s/15s/45s on 429/5xx/network, one repair-prompt retry on malformed
// JSON, then the caller's safe-default path.

const { safeJsonParse } = require('../lib/validate');
const prompts = require('./prompts');

const BACKOFF_MS = [5000, 15000, 45000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class GeminiClient {
  constructor({ apiKey, model, backoffMs = BACKOFF_MS, fetchImpl = fetch } = {}) {
    if (!apiKey) throw new Error('GEMINI_API_KEY is required');
    this.apiKey = apiKey;
    this.model = model || 'gemini-2.5-flash';
    this.backoffMs = backoffMs;
    this.fetch = fetchImpl;
  }

  async complete({ system, user, temperature = 0, maxTokens = 1200, jsonMode = false }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    let lastErr;
    for (let attempt = 0; attempt <= this.backoffMs.length; attempt++) {
      try {
        const res = await this.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: {
              temperature,
              maxOutputTokens: maxTokens,
              ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
            },
          }),
        });
        if (res.status === 429 || res.status >= 500) {
          throw Object.assign(new Error(`Gemini API ${res.status}`), { transient: true });
        }
        if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ?? '';
      } catch (e) {
        lastErr = e;
        const retryable = e.transient || e.name === 'TypeError' || e.code === 'ECONNRESET';
        if (!retryable || attempt === this.backoffMs.length) throw lastErr;
        await sleep(this.backoffMs[attempt]);
      }
    }
    throw lastErr;
  }

  async analyzeTicket(subject, body) {
    const raw = await this.complete({
      system: prompts.ANALYSIS_SYSTEM,
      user: prompts.analysisUser(subject, body),
      temperature: 0,
      maxTokens: 1200,
      jsonMode: true, // Gemini can enforce a JSON response natively
    });
    try {
      return { data: safeJsonParse(raw) };
    } catch {
      const repaired = await this.complete({
        system: prompts.ANALYSIS_SYSTEM,
        user: `Your previous output was not valid JSON. Return only the corrected JSON object, nothing else:\n${raw}`,
        temperature: 0,
        maxTokens: 1200,
        jsonMode: true,
      });
      try {
        return { data: safeJsonParse(repaired) };
      } catch {
        return { parseFailed: true, raw };
      }
    }
  }

  async suggestReply({ category, priority, detailedDescription, ragContext }) {
    const text = await this.complete({
      system: prompts.REPLY_SYSTEM,
      user: prompts.replyUser({ category, priority, detailedDescription, ragContext }),
      temperature: 0.3,
      maxTokens: 500,
    });
    return text.trim();
  }
}

module.exports = { GeminiClient };
