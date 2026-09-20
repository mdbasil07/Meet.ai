/* MeetMind — options page: provider + API key storage. */

const KEY_HINTS = {
  gemini: 'Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>.',
  openai: 'Get a key at <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com/api-keys</a>.'
};

document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.local.get({ provider: 'gemini', apiKey: '', model: '' });
  document.getElementById('provider').value = data.provider;
  document.getElementById('apiKey').value = data.apiKey;
  document.getElementById('model').value = data.model;
  updateHint(data.provider);

  document.getElementById('provider').addEventListener('change', (e) => updateHint(e.target.value));

  document.getElementById('save').addEventListener('click', async () => {
    await chrome.storage.local.set({
      provider: document.getElementById('provider').value,
      apiKey: document.getElementById('apiKey').value.trim(),
      model: document.getElementById('model').value.trim()
    });
    const el = document.getElementById('saved');
    el.textContent = '✓ Saved';
    setTimeout(() => { el.textContent = ''; }, 2000);
  });
});

function updateHint(provider) {
  document.getElementById('keyHint').innerHTML = KEY_HINTS[provider] || '';
}
