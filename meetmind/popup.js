/* MeetMind — popup logic: status, transcript preview, AI summarization, speech. */

const MEETING_URL_RE = /meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com/;

const PROMPT = `You are a meeting assistant. The user attended an online meeting and may have forgotten what they were asked to do. Below is the live-caption transcript.

Extract and return exactly these three sections, in this order, using plain text with simple headings:

YOUR ACTION ITEMS
- Every task, follow-up, or request directed at the listener ("you", "can you", "please", etc.). Include who asked for it and any deadline mentioned. If none, write "None found."

KEY DECISIONS
- Decisions that were made in the meeting, as short bullets. If none, write "None found."

SUMMARY
- 5-8 short bullets covering what was discussed.

Keep it concise. Ignore caption glitches and repeated fragments.`;

let summaryText = '';
let speaking = false;

document.addEventListener('DOMContentLoaded', init);

function $(id) { return document.getElementById(id); }

async function init() {
  $('btnSummarize').addEventListener('click', summarize);
  $('btnSpeak').addEventListener('click', speakSummary);
  $('btnStopSpeak').addEventListener('click', stopSpeaking);
  $('btnCopy').addEventListener('click', copySummary);
  $('btnDownload').addEventListener('click', downloadTranscript);
  $('btnClear').addEventListener('click', clearAll);
  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const stored = await chrome.storage.local.get(['meetmind_summary']);
  if (stored.meetmind_summary) {
    summaryText = stored.meetmind_summary;
    $('summary').innerHTML = renderMarkdownLite(summaryText);
  }

  await refresh();
  setInterval(refresh, 3000);
}

async function getMeetingTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab && MEETING_URL_RE.test(tab.url || '')) return tab;
  } catch (e) { /* no tab access */ }
  return null;
}

async function sendToTab(tab, msg) {
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    return null;
  }
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderPreview(entries) {
  const box = $('transcript');
  if (!entries.length) {
    box.innerHTML = '<span class="muted">Waiting for captions…</span>';
    return;
  }
  box.innerHTML = entries.map((e) =>
    `<div class="line"><span class="ts">${esc(e.time || '')}</span>` +
    `<span class="spk">${esc(e.speaker || 'Speaker')}:</span> ${esc(e.text)}</div>`
  ).join('');
  box.scrollTop = box.scrollHeight;
}

async function refresh() {
  const statusEl = $('status');
  const tab = await getMeetingTab();

  if (!tab) {
    const data = await chrome.storage.local.get(['meetmind_transcript', 'meetmind_updated', 'meetmind_site']);
    const t = data.meetmind_transcript || [];
    if (t.length) {
      const when = data.meetmind_updated ? new Date(data.meetmind_updated).toLocaleTimeString() : '';
      statusEl.textContent = `Last capture: ${t.length} lines (${data.meetmind_site || 'meeting'}${when ? ', ' + when : ''}). Open the meeting tab for live updates.`;
      renderPreview(t.slice(-12));
      $('lineCount').textContent = `(${t.length})`;
    } else {
      statusEl.textContent = 'Open a Google Meet / Zoom / Teams tab with captions (CC) turned on.';
      $('siteBadge').textContent = 'idle';
    }
    return;
  }

  const state = await sendToTab(tab, { type: 'MEETMIND_STATE' });
  if (!state) {
    statusEl.textContent = 'Could not reach this tab — reload the meeting page and try again.';
    return;
  }
  $('siteBadge').textContent = state.site || 'meeting';
  if (!state.captionsFound) {
    statusEl.textContent = 'On a meeting tab, but no captions found. Turn on captions (CC) in the meeting controls.';
  } else {
    statusEl.textContent = `Capturing captions • ${state.lines} lines • ${state.words} words`;
  }
  $('lineCount').textContent = state.lines ? `(${state.lines})` : '';
  renderPreview(state.preview || []);
}

function transcriptToText(transcript) {
  return transcript
    .map((e) => `[${e.time || ''}] ${e.speaker || 'Speaker'}: ${e.text}`)
    .join('\n')
    .slice(-15000);
}

async function summarize() {
  const settings = await chrome.storage.local.get({ provider: 'gemini', apiKey: '', model: '' });
  if (!settings.apiKey) {
    $('summary').innerHTML = '<p>⚠️ Add your API key in <strong>Settings</strong> first — Gemini has a free tier and takes a minute to set up.</p>';
    chrome.runtime.openOptionsPage();
    return;
  }

  let transcript = [];
  const tab = await getMeetingTab();
  if (tab) {
    const res = await sendToTab(tab, { type: 'MEETMIND_TRANSCRIPT' });
    if (res && res.transcript) transcript = res.transcript;
  }
  if (!transcript.length) {
    const data = await chrome.storage.local.get(['meetmind_transcript']);
    transcript = data.meetmind_transcript || [];
  }
  if (!transcript.length) {
    $('summary').innerHTML = '<p>No captions captured yet. Make sure captions (CC) are on in the meeting.</p>';
    return;
  }

  const btn = $('btnSummarize');
  btn.disabled = true;
  btn.textContent = '⏳ Summarizing…';
  $('summary').innerHTML = '<p class="muted">Asking the AI — this takes a few seconds…</p>';

  try {
    summaryText = settings.provider === 'openai'
      ? await summarizeOpenAI(settings, transcriptToText(transcript))
      : await summarizeGemini(settings, transcriptToText(transcript));
    $('summary').innerHTML = renderMarkdownLite(summaryText);
    chrome.storage.local.set({ meetmind_summary: summaryText });
  } catch (err) {
    $('summary').innerHTML = `<p>❌ ${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Summarize';
  }
}

async function summarizeGemini(settings, text) {
  const model = (settings.model || 'gemini-3.6-flash').trim();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: PROMPT + '\n\nTRANSCRIPT:\n' + text }] }] })
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error && data.error.message ? data.error.message : `Gemini request failed (${res.status})`);
  const out = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [])
    .map((p) => p.text || '').join('');
  return out || 'The AI returned an empty summary.';
}

async function summarizeOpenAI(settings, text) {
  const model = (settings.model || 'gpt-4o-mini').trim();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + settings.apiKey },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [{ role: 'user', content: PROMPT + '\n\nTRANSCRIPT:\n' + text }]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error && data.error.message ? data.error.message : `OpenAI request failed (${res.status})`);
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || 'The AI returned an empty summary.';
}

function speakSummary() {
  const text = summaryText || $('summary').innerText;
  if (!text || !text.trim()) return;
  speaking = true;
  $('btnSpeak').hidden = true;
  $('btnStopSpeak').hidden = false;
  chrome.runtime.sendMessage({ type: 'MEETMIND_SPEAK', text }, () => {
    // Speech continues in the background; reset buttons after a while.
    setTimeout(resetSpeakButtons, Math.min(60000, 3000 + text.length * 60));
  });
}

function stopSpeaking() {
  chrome.runtime.sendMessage({ type: 'MEETMIND_STOP_SPEAK' });
  resetSpeakButtons();
}

function resetSpeakButtons() {
  speaking = false;
  $('btnSpeak').hidden = false;
  $('btnStopSpeak').hidden = true;
}

async function copySummary() {
  const text = summaryText || $('summary').innerText;
  try {
    await navigator.clipboard.writeText(text);
    $('btnCopy').textContent = '✓ Copied';
    setTimeout(() => { $('btnCopy').textContent = '⧉ Copy summary'; }, 1500);
  } catch (e) {
    $('btnCopy').textContent = 'Copy failed';
  }
}

async function downloadTranscript() {
  let transcript = [];
  const tab = await getMeetingTab();
  if (tab) {
    const res = await sendToTab(tab, { type: 'MEETMIND_TRANSCRIPT' });
    if (res && res.transcript) transcript = res.transcript;
  }
  if (!transcript.length) {
    const data = await chrome.storage.local.get(['meetmind_transcript']);
    transcript = data.meetmind_transcript || [];
  }
  const text = transcript.map((e) => `[${e.time || ''}] ${e.speaker || 'Speaker'}: ${e.text}`).join('\n');
  const blob = new Blob([text || 'No transcript captured.'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `meetmind-transcript-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function clearAll() {
  const tab = await getMeetingTab();
  if (tab) await sendToTab(tab, { type: 'MEETMIND_CLEAR' });
  try { await chrome.storage.local.remove(['meetmind_transcript', 'meetmind_summary']); } catch (e) {}
  summaryText = '';
  $('summary').innerHTML = 'Nothing summarized yet. Join a meeting with captions (CC) on, then hit <strong>Summarize</strong>.';
  stopSpeaking();
  refresh();
}

/* Minimal markdown renderer for AI output */
function inlineMd(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*(.+?)\*/g, '$1<em>$2</em>');
}

function renderMarkdownLite(md) {
  const lines = (md || '').split('\n');
  let html = '';
  let inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (const raw of lines) {
    const t = raw.trim();
    const heading = t.match(/^(#{1,3})\s+(.*)$/);
    const bullet = t.match(/^([-*•]|\d+[.)])\s+(.*)$/);
    if (heading) {
      closeList();
      html += `<h3>${inlineMd(heading[2])}</h3>`;
    } else if (/^[A-Z][A-Z\s&/]{3,}$/.test(t) && t.length < 60) {
      closeList();
      html += `<h3>${inlineMd(t)}</h3>`;
    } else if (bullet) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineMd(bullet[2])}</li>`;
    } else if (t === '') {
      closeList();
    } else {
      closeList();
      html += `<p>${inlineMd(t)}</p>`;
    }
  }
  closeList();
  return html || '<p class="muted">Empty summary.</p>';
}
