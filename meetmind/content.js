/* MeetMind — content script: captures live meeting captions from the page DOM.
   Google Meet and Teams web have dedicated adapters (verified caption
   selectors); Zoom web is covered by a generic caption-region fallback.
   Note: the Teams *desktop app* is a separate program — this extension only
   runs in the browser, so Teams meetings must be joined at
   teams.microsoft.com / teams.live.com in Chrome or Edge. */

(() => {
  'use strict';
  if (window.__meetmind_loaded) return;
  window.__meetmind_loaded = true;

  const MAX_ENTRIES = 2000;
  const FINALIZE_AFTER_MS = 4000;

  const transcript = [];          // {speaker, text, time, t}
  const blocks = new Map();       // Element -> {speaker, seenText, delta, lastChange}
  let rootEl = null;
  let observer = null;
  let debounceId = null;
  let saveTimer = null;
  let genericPrev = '';
  const site = detectSite();

  // Captions sometimes include call-status noise — never store these lines.
  const SYSTEM_RE = /(joined|left)( the)? (meeting|call)|is presenting|you are (muted|unmuted)|captions? (are|is) (on|off)|meeting (started|ended)|waiting for (the host|others)|recording (started|stopped)|someone is sharing/i;

  function detectSite() {
    const h = location.hostname;
    if (/(^|\.)meet\.google\.com$/.test(h)) return 'meet';
    if (h.includes('zoom.us')) return 'zoom';
    if (h.includes('teams.microsoft.com') || h.includes('teams.live.com')) return 'teams';
    return 'generic';
  }

  const clean = (s) => (s || '').replace(/[​‌‍]/g, '').replace(/\s+/g, ' ').trim();
  const isSystem = (t) => SYSTEM_RE.test(t);

  /* ---------------- Google Meet adapter ---------------- */
  const MEET_ROOT_SELECTORS = ['.a4cQT', '[jsname="dsyhDe"]'];
  const MEET_BLOCK_SELECTORS = '.nMcdL, .bj4p3b';
  const MEET_SPEAKER_SELECTORS = '.NWpY1d, .KcIKyf';
  const MEET_TEXT_SELECTORS = '.VbkSUe, .ygicle';

  function findMeetRoot() {
    for (const sel of MEET_ROOT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    const regions = document.querySelectorAll('div[role="region"]');
    for (const r of regions) {
      const label = (r.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('caption')) return r;
    }
    return null;
  }

  function readMeetBlocks(root) {
    const out = [];
    let nodes = root.querySelectorAll(MEET_BLOCK_SELECTORS);
    if (!nodes.length) {
      nodes = Array.from(root.children).filter((c) => clean(c.innerText).length > 2);
    }
    nodes.forEach((node) => {
      const sp = node.querySelector(MEET_SPEAKER_SELECTORS);
      const tx = node.querySelector(MEET_TEXT_SELECTORS);
      const speaker = clean(sp && sp.innerText);
      const text = clean(tx ? tx.innerText : node.innerText);
      if (text) out.push({ el: node, speaker, text });
    });
    return out;
  }

  /* ---------------- Microsoft Teams web adapter ----------------
     Verified against Teams web caption DOM: the caption virtual list
     renders one [data-tid="closed-caption-text"] element per utterance;
     its text grows as speech is recognized and finalizes when the next
     utterance appears. The speaker name sits in [data-tid="author"],
     usually inside the same .fui-ChatMessageCompact block. */
  const TEAMS_ROOT_SELECTORS = [
    "[data-tid='closed-captions-renderer']",
    ".closed-caption-v2-virtual-list-content"
  ];
  const TEAMS_TEXT_SELECTOR = '[data-tid="closed-caption-text"]';
  const TEAMS_AUTHOR_SELECTOR = '[data-tid="author"]';

  function findTeamsRoot() {
    for (const sel of TEAMS_ROOT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && clean(el.innerText).length > 2) return el;
    }
    // Fallback: climb from any caption text node to a container holding several.
    const t = document.querySelector(TEAMS_TEXT_SELECTOR);
    if (t) {
      let p = t.parentElement;
      for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
        if (p.querySelectorAll(TEAMS_TEXT_SELECTOR).length > 1) return p;
      }
      return t.parentElement;
    }
    return null;
  }

  function findTeamsSpeaker(tx, root) {
    const block = (tx.closest && tx.closest('.fui-ChatMessageCompact')) || tx.parentElement;
    if (block) {
      const a = block.querySelector(TEAMS_AUTHOR_SELECTOR);
      if (a && clean(a.innerText)) return clean(a.innerText);
    }
    let p = tx.parentElement;
    for (let i = 0; i < 3 && p && p !== root.parentElement; i++, p = p.parentElement) {
      const a = p.querySelector(TEAMS_AUTHOR_SELECTOR);
      if (a && clean(a.innerText)) return clean(a.innerText);
    }
    return '';
  }

  function readTeamsBlocks(root) {
    const out = [];
    root.querySelectorAll(TEAMS_TEXT_SELECTOR).forEach((tx) => {
      const text = clean(tx.innerText);
      if (!text) return;
      out.push({ el: tx, speaker: findTeamsSpeaker(tx, root), text });
    });
    return out;
  }

  /* ---------------- Structured adapter (Meet / Teams) ----------------
     Both render one element per utterance whose text grows (interim) and
     then finalizes; the logic below is shared. */

  function processStructured(readBlocks) {
    const now = Date.now();
    const current = readBlocks(rootEl);
    const seen = new Set(current.map((c) => c.el));
    const hasNew = current.some((c) => !blocks.has(c.el));

    if (hasNew) {
      // A new caption block appeared: the previous speaker's turn is over.
      for (const [, b] of Array.from(blocks)) commitTurn(b);
      blocks.clear();
    }

    current.forEach(({ el, speaker, text }) => {
      let b = blocks.get(el);
      if (!b) {
        b = { speaker: '', seenText: '', delta: '', lastChange: now };
        blocks.set(el, b);
      }
      if (speaker) b.speaker = speaker;
      if (text.length >= b.seenText.length && text.startsWith(b.seenText)) {
        if (text.length > b.seenText.length) {
          b.delta += (b.delta ? ' ' : '') + text.slice(b.seenText.length).trim();
          b.lastChange = now;
        }
        b.seenText = text;
      } else {
        // Speech recognition revised earlier words; resync without duplicating.
        b.seenText = text;
        b.lastChange = now;
      }
    });

    for (const [el, b] of Array.from(blocks)) {
      if (!seen.has(el) || now - b.lastChange > FINALIZE_AFTER_MS) {
        commitTurn(b);
        blocks.delete(el);
      }
    }
  }

  /* ---------------- Generic adapter (Zoom / Teams / others) ---------------- */
  const GENERIC_SELECTORS = [
    '[data-tid*="caption" i]',
    '[aria-label*="caption" i]',
    '[class*="closed-caption" i]',
    '[class*="live-caption" i]',
    '[role="log"]',
    '[aria-live="polite"]',
    '[aria-live="assertive"]'
  ];

  function findGenericRoot() {
    for (const sel of GENERIC_SELECTORS) {
      let els = [];
      try {
        els = Array.from(document.querySelectorAll(sel)).filter(
          (e) => e.offsetParent !== null && clean(e.innerText).length > 10
        );
      } catch (e) { /* invalid selector on this page */ }
      if (els.length) {
        els.sort((a, b) => clean(b.innerText).length - clean(a.innerText).length);
        return els[0];
      }
    }
    return null;
  }

  function processGeneric() {
    const text = clean(rootEl.innerText);
    if (!text) return;
    if (genericPrev && text.startsWith(genericPrev)) {
      const suffix = clean(text.slice(genericPrev.length));
      if (suffix && !isSystem(suffix)) pushEntry('', suffix);
    } else if (!genericPrev && text.length > 10 && !isSystem(text)) {
      pushEntry('', text);
    }
    genericPrev = text;
  }

  /* ---------------- Shared helpers ---------------- */

  function commitTurn(b) {
    const text = clean(b.delta || b.seenText);
    if (!text || isSystem(text)) return;
    const speaker = b.speaker || 'Speaker';
    const last = transcript[transcript.length - 1];
    if (last) {
      if (last.text.includes(text)) return; // already captured
      if (text.includes(last.text) && last.speaker === speaker) {
        last.text = text; // interim words finalized into the fuller line
        scheduleSave();
        return;
      }
      if (last.speaker === speaker && Date.now() - last.t < 120000) {
        last.text = clean(last.text + ' ' + text); // same speaker, continuing turn
        scheduleSave();
        return;
      }
    }
    transcript.push({ speaker, text, time: new Date().toLocaleTimeString(), t: Date.now() });
    if (transcript.length > MAX_ENTRIES) transcript.splice(0, transcript.length - MAX_ENTRIES);
    scheduleSave();
  }

  function pushEntry(speaker, text) {
    const spk = speaker || 'Speaker';
    const last = transcript[transcript.length - 1];
    if (last && last.speaker === spk && Date.now() - last.t < 60000) {
      last.text = clean(last.text + ' ' + text);
    } else {
      transcript.push({ speaker: spk, text, time: new Date().toLocaleTimeString(), t: Date.now() });
      if (transcript.length > MAX_ENTRIES) transcript.splice(0, transcript.length - MAX_ENTRIES);
    }
    scheduleSave();
  }

  function finalizeAll() {
    for (const [, b] of Array.from(blocks)) commitTurn(b);
    blocks.clear();
  }

  function attachObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(debouncedTick);
    observer.observe(rootEl, { childList: true, subtree: true, characterData: true });
  }

  function debouncedTick() {
    if (debounceId) return;
    debounceId = setTimeout(() => { debounceId = null; tick(); }, 400);
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        chrome.storage.local.set({
          meetmind_transcript: transcript.slice(-500),
          meetmind_updated: Date.now(),
          meetmind_site: site
        });
      } catch (e) { /* storage unavailable */ }
    }, 2000);
  }

  function tick() {
    if (!rootEl || !document.contains(rootEl)) {
      rootEl = site === 'meet' ? findMeetRoot()
             : site === 'teams' ? findTeamsRoot()
             : findGenericRoot();
      if (!rootEl) return;
      attachObserver();
    }
    if (site === 'meet') processStructured(readMeetBlocks);
    else if (site === 'teams') processStructured(readTeamsBlocks);
    else processGeneric();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'MEETMIND_PING') {
      sendResponse({ ok: true, site });
      return true;
    }
    if (msg.type === 'MEETMIND_STATE') {
      finalizeAll(); // flush anything captured so far
      const words = transcript.reduce((n, e) => n + e.text.split(/\s+/).filter(Boolean).length, 0);
      sendResponse({
        site,
        captionsFound: !!rootEl,
        lines: transcript.length,
        words,
        preview: transcript.slice(-12)
      });
      return true;
    }
    if (msg.type === 'MEETMIND_TRANSCRIPT') {
      finalizeAll();
      sendResponse({ transcript: transcript.slice() });
      return true;
    }
    if (msg.type === 'MEETMIND_CLEAR') {
      transcript.length = 0;
      blocks.clear();
      genericPrev = '';
      try { chrome.storage.local.remove(['meetmind_transcript', 'meetmind_summary']); } catch (e) {}
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  tick();
  setInterval(tick, 2500);
})();
