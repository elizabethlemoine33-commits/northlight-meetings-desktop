// ── Prompt Builder ─────────────────────────────────────────────────────────────
function buildPrompt(mode, transcript, feedback, title, clientName) {
  const feedbackSection = feedback
    ? `\n\n## Post-call feedback from the host (treat as HIGH PRIORITY context — this overrides or clarifies the transcript):\n${feedback}`
    : '';

  const currentYear = new Date().getFullYear();
  const baseContext = `You are a highly capable meeting analyst for an agency called Northlight. You are processing a "${mode}" mode call.

Meeting title: ${title}
${clientName ? `Client: ${clientName}` : ''}

## Call transcript:
${transcript}${feedbackSection}

Return a single valid JSON object with ONLY the fields listed below. No markdown, no explanation, just raw JSON. Populate all fields as best you can from the call. Use null for any field that cannot be determined from the transcript.`;

  if (mode === 'discover') {
    return `${baseContext}

{
  "summary": "2-3 paragraph summary of the call — what the client needs, key signals, tone",
  "actionItems": [{ "id": "a1", "text": "action item text", "assignee": "person or null", "dueDate": "ISO date string or null", "approved": false }],
  "clickupTasks": [{ "id": "t1", "title": "task title", "description": "details", "priority": "high|normal|low or null", "dueDate": "ISO or null", "existingTaskId": null, "action": "create", "approved": false }],
  "openQuestions": ["question that came up with no answer"],
  "extractedDates": [{ "id": "d1", "description": "what this date is for", "dateText": "exact words spoken", "isoDate": "ISO 8601 date string — if no year is mentioned assume ${currentYear}; if no time is mentioned use date-only format YYYY-MM-DD; null only if no date can be inferred at all", "approved": false }],
  "sowDraft": {
    "problem_statement": "paragraph describing the client's problem or opportunity",
    "in_scope_1": "first in-scope item or null",
    "in_scope_2": "second in-scope item or null",
    "in_scope_3": "third in-scope item or null",
    "out_scope_1": "first out-of-scope item or null",
    "out_scope_2": "second out-of-scope item or null",
    "deliverable_1": "first deliverable or null",
    "deliverable_2": "second deliverable or null",
    "deliverable_3": "third deliverable or null",
    "approach_summary": "paragraph describing Northlight's approach",
    "phase1_focus": "Phase 1 focus area or null",
    "phase1_timing": "Phase 1 timing e.g. Week 1-2 or null",
    "phase2_focus": "Phase 2 focus area or null",
    "phase2_timing": "Phase 2 timing or null",
    "phase3_focus": "Phase 3 focus area or null",
    "phase3_timing": "Phase 3 timing or null",
    "line1_desc": "first fee line description or null",
    "line1_amount": "amount as number string e.g. 2500 or null",
    "line2_desc": "second fee line description or null",
    "line2_amount": "amount or null",
    "project_fee": "total project fee as number string or null",
    "payment_terms": "e.g. 50% upfront, 50% on delivery or null",
    "next_steps_text": "paragraph describing immediate next steps"
  },
  "followUpEmailDraft": "Subject: ...\\n\\nHi [Name],\\n\\n..."
}`;
  }

  if (mode === 'progress') {
    return `${baseContext}

{
  "summary": "2-3 paragraph summary — what's done, what's blocked, key decisions",
  "actionItems": [{ "id": "a1", "text": "action item", "assignee": "person or null", "dueDate": "ISO or null", "approved": false }],
  "clickupTasks": [{ "id": "t1", "title": "task name matching existing task", "description": "update notes", "priority": null, "dueDate": null, "existingTaskId": null, "action": "update", "approved": false }],
  "decisions": [{ "id": "dec1", "text": "we decided to...", "approved": false }],
  "parkingLot": [{ "id": "p1", "text": "thing that came up but got deferred", "approved": false }],
  "commitments": [{ "id": "c1", "person": "Name", "commitment": "what they said they'd do", "dueDate": "ISO or null", "approved": false }],
  "extractedDates": [{ "id": "d1", "description": "what this is for", "dateText": "exact words", "isoDate": "ISO 8601 date string — if no year is mentioned assume ${currentYear}; YYYY-MM-DD for date-only; null only if truly no date", "approved": false }],
  "openQuestions": ["unresolved question"],
  "meetingNotesDraft": {
    "meeting_type": "Status Call",
    "key_point_1": "first key point or null",
    "key_point_2": "second key point or null",
    "key_point_3": "third key point or null",
    "decision_1": "first decision or null",
    "decision_1_owner": "owner name or null",
    "decision_2": "second decision or null",
    "decision_2_owner": "owner name or null",
    "action_1_owner": "owner name or null",
    "action_1_item": "action item or null",
    "action_1_due": "due date text or null",
    "action_2_owner": "owner name or null",
    "action_2_item": "action item or null",
    "action_2_due": "due date text or null",
    "action_3_owner": "owner name or null",
    "action_3_item": "action item or null",
    "action_3_due": "due date text or null",
    "next_meeting_date": "date text or null",
    "next_meeting_time": "time text or null",
    "next_meeting_agenda": "agenda summary or null"
  },
  "followUpEmailDraft": "Subject: ...\\n\\nHi team,\\n\\n..."
}`;
  }

  // notes mode
  return `${baseContext}

{
  "summary": "2-3 paragraph structured summary of what was discussed and decided",
  "actionItems": [{ "id": "a1", "text": "action item", "assignee": "person or null", "dueDate": null, "approved": false }],
  "decisions": [{ "id": "dec1", "text": "decision made", "approved": false }],
  "parkingLot": [{ "id": "p1", "text": "deferred topic", "approved": false }],
  "openQuestions": ["open question"],
  "extractedDates": [{ "id": "d1", "description": "what for", "dateText": "words spoken", "isoDate": "ISO 8601 date string — if no year is mentioned assume ${currentYear}; YYYY-MM-DD for date-only; null only if truly no date", "approved": false }],
  "meetingNotesDraft": {
    "meeting_type": "Internal Meeting",
    "key_point_1": "first key point or null",
    "key_point_2": "second key point or null",
    "key_point_3": "third key point or null",
    "decision_1": "first decision or null",
    "decision_1_owner": "owner name or null",
    "decision_2": "second decision or null",
    "decision_2_owner": "owner name or null",
    "action_1_owner": "owner name or null",
    "action_1_item": "action item or null",
    "action_1_due": "due date text or null",
    "action_2_owner": "owner name or null",
    "action_2_item": "action item or null",
    "action_2_due": "due date text or null",
    "action_3_owner": "owner name or null",
    "action_3_item": "action item or null",
    "action_3_due": "due date text or null",
    "next_meeting_date": "date text or null",
    "next_meeting_time": "time text or null",
    "next_meeting_agenda": "agenda summary or null"
  },
  "followUpEmailDraft": "Subject: ...\\n\\nHi,\\n\\n..."
}`;
}

// ── LLM Call ───────────────────────────────────────────────────────────────────
async function analyzeTranscript({ transcript, feedback, mode, title, clientName }, apiKey) {
  const prompt = buildPrompt(mode, transcript, feedback || null, title, clientName || null);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: 'Return only raw JSON. No markdown, no explanation.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const e = new Error(err.error?.message || 'Analysis failed');
      e.status = response.status;
      throw e;
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';

    // Strip accidental markdown wrapping
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
      const e = new Error('Analysis returned invalid JSON');
      e.status = 500;
      throw e;
    }

    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      const e = new Error('timeout');
      e.status = 0;
      throw e;
    }
    throw err;
  }
}

module.exports = { analyzeTranscript };
