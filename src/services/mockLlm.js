'use strict';
// Deterministic keyword classifier standing in for Claude so the demo and
// integration tests run with zero credentials. Interface-compatible with
// ClaudeClient (analyzeTicket / suggestReply). Set `failNext = true` to
// simulate a malformed AI response for error-injection testing.

class MockLLM {
  constructor() {
    this.failNext = false;
  }

  async analyzeTicket(subject, body) {
    if (this.failNext) {
      this.failNext = false;
      return { parseFailed: true, raw: 'Sure! Here is the JSON you asked for: {broken' };
    }
    const text = `${subject} ${body}`.toLowerCase();
    const has = (...words) => words.some((w) => text.includes(w));

    let category = 'Other';
    let priority = 'Low';
    let sentiment = 'Neutral';
    let confidence = 0.4;

    if (has('outage', 'down', '503', 'not working')) {
      category = 'Technical Support'; priority = 'Critical'; sentiment = 'Negative'; confidence = 0.95;
    } else if (has('charged twice', 'refund', 'duplicate charge', 'statement', 'invoice')) {
      category = 'Billing'; priority = 'High'; sentiment = 'Negative'; confidence = 0.9;
    } else if (has('pricing', 'enterprise', 'seats', 'trial', 'discount')) {
      category = 'Sales Inquiry'; priority = 'Low'; sentiment = 'Positive'; confidence = 0.9;
    } else if (has('feature request', 'would save', 'on your radar', 'ability to')) {
      category = 'Feature Request'; priority = 'Low'; sentiment = 'Positive'; confidence = 0.88;
    } else if (has('login', 'password', 'locked out', 'access')) {
      category = 'Account Access'; priority = 'Medium'; sentiment = 'Neutral'; confidence = 0.85;
    }

    const nameMatch = body.match(/\n([A-Z][a-z]+ [A-Z][a-z]+)\s*\n/);
    return {
      data: {
        customer_name: nameMatch ? nameMatch[1] : null,
        company: null,
        issue_summary: `${category === 'Other' ? 'Unclear request' : category} regarding: ${subject.slice(0, 80)}`,
        detailed_description: body.split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 300),
        category,
        priority,
        priority_justification: `Mock heuristic: keyword-based ${category} classification.`,
        sentiment,
        product_service: has('api') ? 'API' : null,
        suggested_department: category,
        suggested_tags: [category.split(' ')[0], sentiment],
        detected_language: 'en',
        confidence_score: confidence,
      },
    };
  }

  async suggestReply({ category, detailedDescription, ragContext }) {
    const kbUsed = ragContext.startsWith('(') ? 'our team' : 'our documentation';
    return `Thank you for contacting us about your ${category.toLowerCase()} issue. We understand: "${detailedDescription.slice(0, 120)}...". Based on ${kbUsed}, an agent is reviewing the details now and will follow up with specific next steps. (Mock draft — set ANTHROPIC_API_KEY to generate real ones.)`;
  }
}

module.exports = { MockLLM };
