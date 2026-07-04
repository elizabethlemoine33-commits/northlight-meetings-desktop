// ── Drive push ────────────────────────────────────────────────────────────────
async function pushToDrive({ session, templateFileId, targetFolderId, accessToken }) {
  const clientName = session.client_name || 'Client';
  const projectName = session.project_name || 'Project';
  const dateStr = new Date(session.created_at).toLocaleDateString('en-CA', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  const isDiscover = session.mode === 'discover';
  const docName = isDiscover
    ? `${clientName} — ${projectName} — SOW ${dateStr}`
    : `${clientName} — ${projectName} — Meeting Notes ${dateStr}`;

  // 1. Copy the master template into the target folder
  const copyBody = { name: docName };
  if (targetFolderId) copyBody.parents = [targetFolderId];

  const copyRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${templateFileId}/copy?fields=id`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(copyBody),
    }
  );
  if (!copyRes.ok) {
    const errText = await copyRes.text();
    throw new Error(`Drive copy failed (${copyRes.status}): ${errText}`);
  }
  const { id: newDocId } = await copyRes.json();

  // 2. Build replaceAllText requests from the draft object
  const draftObj = isDiscover ? session.analysis?.sowDraft : session.analysis?.meetingNotesDraft;
  const requests = [];

  if (draftObj && typeof draftObj === 'object') {
    for (const [tag, value] of Object.entries(draftObj)) {
      requests.push({
        replaceAllText: {
          containsText: { text: `{{${tag}}}`, matchCase: true },
          replaceText: value ?? '',
        },
      });
    }
  }

  // Metadata fills (from session, not LLM)
  const metaFields = {
    client_name: clientName,
    project_name: projectName,
    date: dateStr,
    prepared_by: 'Elizabeth Lemoine',
  };
  for (const [tag, value] of Object.entries(metaFields)) {
    requests.push({
      replaceAllText: {
        containsText: { text: `{{${tag}}}`, matchCase: true },
        replaceText: value,
      },
    });
  }

  // 3. Apply all replacements in a single batchUpdate call
  if (requests.length > 0) {
    const docsRes = await fetch(
      `https://docs.googleapis.com/v1/documents/${newDocId}:batchUpdate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      }
    );
    if (!docsRes.ok) {
      const errText = await docsRes.text();
      throw new Error(`Docs batchUpdate failed (${docsRes.status}): ${errText}`);
    }
  }

  return {
    docId: newDocId,
    docUrl: `https://docs.google.com/document/d/${newDocId}/edit`,
    docName,
  };
}

// ── ClickUp push ──────────────────────────────────────────────────────────────
async function pushToClickup({ session, listId, clickupApiKey }) {
  const priorityMap = { urgent: 1, high: 2, normal: 3, low: 4 };
  const tasks = (session.analysis?.clickupTasks || []).filter(t => t.approved);
  const urls = [];

  for (const task of tasks) {
    try {
      const body = { name: task.title };
      if (task.description) body.description = task.description;
      if (task.priority && priorityMap[task.priority]) body.priority = priorityMap[task.priority];
      if (task.dueDate) body.due_date = new Date(task.dueDate).getTime();

      const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
        method: 'POST',
        headers: { Authorization: clickupApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.url) urls.push(data.url);
    } catch {}
  }

  return { taskCount: urls.length, urls };
}

// ── Calendar push ─────────────────────────────────────────────────────────────
async function pushToCalendar({ session, accessToken }) {
  const dates = (session.analysis?.extractedDates || []).filter(d => d.approved && d.isoDate);
  const urls = [];
  const sessionLabel = [session.client_name, session.project_name].filter(Boolean).join(' — ');

  for (const date of dates) {
    try {
      const isDateOnly = !date.isoDate.includes('T');
      const start = new Date(date.isoDate);
      const description = `From: ${sessionLabel}\n\n"${date.dateText}"`;

      const eventBody = isDateOnly
        ? {
            summary: date.description,
            description,
            start: { date: date.isoDate.substring(0, 10) },
            end: { date: date.isoDate.substring(0, 10) },
          }
        : {
            summary: date.description,
            description,
            start: { dateTime: start.toISOString() },
            end: { dateTime: new Date(start.getTime() + 60 * 60 * 1000).toISOString() },
          };

      const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(eventBody),
      });
      const data = await res.json();
      if (data.htmlLink) urls.push(data.htmlLink);
    } catch {}
  }

  return { eventCount: urls.length, urls };
}

module.exports = { pushToDrive, pushToClickup, pushToCalendar };
