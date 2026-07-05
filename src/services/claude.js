'use strict';
// Step 2 — AI Ticket Analysis via the Anthropic Messages API.
// Retry policy (plan §9): exponential backoff 5s/15s/45s on 429/5xx/network,
// then the caller falls back to safe defaults. Malformed JSON gets exactly one
// "repair prompt" retry before the safe-default path.

const { safeJsonParse } = require('../lib/validate');
const prompts = require('./prompts');

const BACKOFF_MS = [5000, 15000, 45000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ClaudeClient {
  constructor({ apiKey, model, backoffMs = BACKOFF_MS, fetchImpl = fetch } = {}) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');
    this.apiKey = apiKey;
    this.model = model || 'claude-sonnet-5';
    this.backoffMs = backoffMs;
    this.fetch = fetchImpl;
  }

  async complete({ system, user, temperature = 0, maxTokens = 1200 }) {
    let lastErr;
    for (let attempt = 0; attempt <= this.backoffMs.length; attempt++) {
      try {
        const res = await this.fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: maxTokens,
            temperature,
            system,
            messages: [{ role: 'user', content: user }],
          }),
        });
        if (res.status === 429 || res.status >= 500) {
          throw Object.assign(new Error(`Anthropic API ${res.status}`), { transient: true });
        }
        if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = await res.json();
        return data.content?.[0]?.text ?? '';
      } catch (e) {
        lastErr = e;
        const retryable = e.transient || e.name === 'TypeError' || e.code === 'ECONNRESET';
        if (!retryable || attempt === this.backoffMs.length) throw lastErr;
        await sleep(this.backoffMs[attempt]);
      }
    }
    throw lastErr;
  }

  /**
   * Prompt 1: returns { data } on success or { parseFailed: true, raw } after
   * the repair retry also fails. Transport errors propagate to the caller,
   * which applies the never-drop-a-ticket defaults.
   */
  async analyzeTicket(subject, body) {
    const raw = await this.complete({
      system: prompts.ANALYSIS_SYSTEM,
      user: prompts.analysisUser(subject, body),
      temperature: 0,
      maxTokens: 1200,
    });
    try {
      return { data: safeJsonParse(raw) };
    } catch {
      const repaired = await this.complete({
        system: prompts.ANALYSIS_SYSTEM,
        user: `Your previous output was not valid JSON. Return only the corrected JSON object, nothing else:\n${raw}`,
        temperature: 0,
        maxTokens: 1200,
      });
      try {
        return { data: safeJsonParse(repaired) };
      } catch {
        return { parseFailed: true, raw };
      }
    }
  }

  /** Prompt 2 (bonus): plain-text reply draft for agent review. */
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

module.exports = { ClaudeClient };
