/* MeetMind — background service worker: text-to-speech + install defaults. */

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['provider'], (d) => {
    if (!d.provider) {
      chrome.storage.local.set({ provider: 'gemini', model: '', apiKey: '' });
    }
  });
});

function speechText(raw) {
  return (raw || '')
    .replace(/[*#_`>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'MEETMIND_SPEAK' && msg.text) {
    try {
      chrome.tts.stop();
      chrome.tts.speak(speechText(msg.text), { rate: 1.0 });
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true;
  }
  if (msg.type === 'MEETMIND_STOP_SPEAK') {
    try { chrome.tts.stop(); } catch (e) {}
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
