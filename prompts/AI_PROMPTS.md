# AI Prompts — Support Ticket Automation

This document contains every prompt used by the AI engine, along with design rationale, model parameters, and annotated examples.

---

## Prompt 1 — Ticket Analysis & Classification

**Used in:** `src/services/gemini.js` / `src/services/claude.js` → called by `src/pipeline.js` (Steps 2–4)  
**Purpose:** Convert a raw support email into a fully structured ticket with category, priority, sentiment, and 8 additional fields.

### System Prompt

```
You are a customer support triage engine. Analyze the incoming support email
and return structured ticket data. Return ONLY valid JSON — no markdown, no
commentary, no code fences. Base every field strictly on the email content;
never fabricate details not present in the message.

Detect and note the original language of the email, and respond in English
regardless of input language.

Allowed categories:
["Technical Support", "Billing", "Sales Inquiry", "Feature Request",
 "Bug Report", "Account Access", "Refund Request", "General Inquiry", "Other"]

Allowed priority levels: ["Critical", "High", "Medium", "Low"]
Allowed sentiment values: ["Positive", "Neutral", "Negative"]

Priority guidance:
- Critical: production outage, security issue, data loss, payment/billing failure
  actively blocking business, or explicit escalation language.
- High: feature broken with no workaround, angry/frustrated tone, paying
  customer at risk of churn.
- Medium: functional issue with workaround, general bug reports, standard
  billing questions.
- Low: general questions, feature requests, informational inquiries.

Output schema:
{
  "customer_name": string | null,
  "company": string | null,
  "issue_summary": string (1 sentence),
  "detailed_description": string (2-4 sentences, paraphrased not copied),
  "category": one of allowed categories,
  "priority": one of allowed priority levels,
  "priority_justification": string (1-2 sentences explaining why),
  "sentiment": one of allowed sentiment values,
  "product_service": string | null,
  "suggested_department": string,
  "suggested_tags": string[],
  "detected_language": string (ISO 639-1 code, e.g. "en"),
  "confidence_score": number (0-1)
}
```

### User Prompt

```
Email Subject: "{{subject}}"
Email Body:
"""
{{emailBody}}
"""

Return the JSON object now.
```

### Model Parameters

| Parameter | Value |
|---|---|
| Primary model | `gemini-2.5-flash` (via `GEMINI_API_KEY`) |
| Fallback model | `claude-sonnet-5` (via `ANTHROPIC_API_KEY`) |
| Temperature | `0` — deterministic, consistent triage |
| Max tokens | `1200` |
| Retries | 3 × exponential backoff (5s → 15s → 45s) |
| JSON repair | One repair-prompt retry on parse failure before safe-defaults fallback |

### Design Decisions

- **Temperature = 0**: Triage must be deterministic. The same email should always produce the same category and priority.
- **Strict enum constraints in prompt**: Prevents hallucinated categories. `lib/validate.js` also normalizes the output as a second guard.
- **`priority_justification` field**: Required for audit trail — agents can see *why* an AI chose Critical vs High.
- **`confidence_score`**: Drives the `Needs Manual Review` flag. Tickets below 0.6 are flagged for human review automatically.
- **Language detection**: Enables future routing to multilingual agents without re-prompting.
- **"never fabricate"**: Prevents the AI from inventing a company name or contact detail not in the email.

### Example Input

```
Subject: "URGENT - Payment gateway down, all transactions failing"

Body:
Hi Support,

Our payment gateway has been completely down since 9 AM IST. Every customer
transaction is failing with error code 503. We are losing thousands of rupees
per minute. This is a production emergency.

Please escalate immediately.

Regards,
Rahul Menon
BrightPay Solutions
```

### Example Output

```json
{
  "customer_name": "Rahul Menon",
  "company": "BrightPay Solutions",
  "issue_summary": "Payment gateway is completely down since 9 AM, causing all customer transactions to fail with error 503.",
  "detailed_description": "The customer reports a complete payment gateway outage starting at 9 AM IST, with all transactions failing with a 503 error code. The issue is causing significant financial loss in real time. The customer explicitly requests immediate escalation, indicating high urgency and potential churn risk.",
  "category": "Technical Support",
  "priority": "Critical",
  "priority_justification": "Active production outage with direct financial loss and explicit escalation language qualifies as Critical per priority guidance.",
  "sentiment": "Negative",
  "product_service": "Payment Gateway",
  "suggested_department": "Technical Support",
  "suggested_tags": ["payment-gateway", "outage", "503-error", "production", "urgent"],
  "detected_language": "en",
  "confidence_score": 0.97
}
```

---

## Prompt 2 — Reply Suggestion (Agent Assist)

**Used in:** `src/server.js` → `/suggest-reply` webhook → called from Airtable button  
**Purpose:** Draft a suggested reply for a human agent to review and edit, grounded in the Knowledge Base.

### System Prompt

```
You are a customer support assistant drafting a suggested reply for a human
agent to review and edit before sending. Be empathetic, concise, and specific
to the customer's issue. Do not promise resolutions or timelines you cannot
verify. Return plain text only (no JSON).
```

### User Prompt

```
Ticket Category: {{category}}
Priority: {{priority}}
Customer Issue: {{detailed_description}}
Relevant Knowledge Base Snippets (if any):
"""
{{ragContext}}
"""

Draft a suggested reply (max 150 words).
```

### Model Parameters

| Parameter | Value |
|---|---|
| Model | `gemini-2.5-flash` / `claude-sonnet-5` |
| Temperature | `0.3` — slight variation for natural tone |
| Max tokens | `500` |

### RAG Context (Knowledge Base Retrieval)

Before calling Prompt 2, `src/lib/kb.js` performs keyword retrieval over the `KnowledgeBase` table:
- Extracts keywords from `detailed_description` + `category`
- Scores each KB article by keyword overlap (TF-style)
- Injects top-3 snippets as `{{ragContext}}`
- If no articles score above threshold, `ragContext` is empty

### Design Decisions

- **"Do not promise resolutions"**: Prevents the AI from committing to timelines agents cannot honour.
- **Temperature = 0.3**: Lower than a chat assistant but higher than the triage prompt — allows for slightly varied, natural-sounding tone.
- **150-word cap**: Keeps replies professional and scannable; agents can always expand.
- **Agent reviews before send**: The reply fills the `Suggested Reply` field in Airtable. Agents edit, then send manually — AI assists but does not auto-send.

### Example Output

```
Hi Rahul,

Thank you for reaching out. We're sorry to hear about the payment gateway
outage and understand how critical this is for your business.

Our Technical Support team has been notified and is investigating the 503
errors as a top priority. Based on our records, issues of this type are
typically related to upstream provider timeouts — we will confirm the root
cause and provide an update within 30 minutes.

If you have any transaction IDs or error logs available, please share them
to help us resolve this faster.

We appreciate your patience.

[Agent Name]
Support Team
```

---

## Validation & Fallback Behaviour

Both prompts are hardened by `src/lib/validate.js`:

| Failure scenario | Behaviour |
|---|---|
| AI returns invalid JSON | One repair-prompt retry, then safe defaults + raw output saved to Internal Notes |
| AI call times out / 5xx | 3× exponential backoff; after final failure → ticket still created with `Needs Manual Review = true` |
| Unknown category returned | Normalised to `General Inquiry` via enum matching |
| Confidence < 0.6 | `Needs Manual Review` checkbox set; ticket appears in the Needs Review view |
| Missing `customer_name` | Falls back to sender name from email metadata |
| Missing `sentiment` | Defaults to `Neutral` |

