# MeetMind — AI Meeting Caption Summarizer

A Chrome extension (Manifest V3) that watches the **live captions** in your online
meetings, collects what everyone says, and — when you ask — sends the transcript
to an AI to produce:

- **Your action items** — what you were asked to do, who asked, and deadlines
- **Key decisions** made in the meeting
- **A short summary** of the discussion

It can also **read the summary aloud** to you, so you never lose track again.

No audio is ever recorded — it only reads the caption text already shown on screen.

## Install (2 minutes)

1. Open `chrome://extensions` in Chrome (or Edge/Brave).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `meetmind` folder.
4. Pin MeetMind to your toolbar for easy access.

> If you install it while a meeting tab is already open, **reload that tab** once.

## Set up the AI (one time)

1. Click the MeetMind icon → **⚙ Settings & API key**.
2. Choose a provider and paste an API key:
   - **Google Gemini** (recommended) — free tier at
     [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
   - **OpenAI** — key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
3. Press **Save**.

Your key is stored only in your browser. Captions are sent to the AI provider
**only when you press “Summarize”** — never automatically.

## Use it in a meeting

1. Join a Google Meet, or a Zoom / Teams meeting **in the browser**
   (Chrome or Edge) at zoom.us / teams.microsoft.com — the extension can't
   run inside the Zoom or Teams *desktop apps*, they're separate programs.
2. Turn **captions (CC)** on in the meeting controls — the extension can only
   read captions that are visible.
3. Click the MeetMind icon anytime:
   - **✨ Summarize** — AI summary with your action items, decisions, key points.
   - **🔊 Read aloud** — speaks the summary to you.
   - **⧉ Copy summary** / **⬇ Transcript** — copy or download as `.txt`.
   - **Clear** — wipe the captured transcript.

## How it works

- `content.js` finds the caption region in the meeting page DOM (Google Meet
  selectors verified: `.a4cQT` → `.nMcdL` blocks → `.NWpY1d` speaker +
  `.VbkSUe` text, with fallbacks) and watches it with a `MutationObserver`.
- Caption lines are deduplicated, grouped by speaker turn, timestamped, and
  kept in memory + `chrome.storage.local`.
- `popup.js` sends the transcript to Gemini/OpenAI on demand and renders the
  summary; `background.js` handles text-to-speech via `chrome.tts`.

## Troubleshooting

| Problem | Fix |
|---|---|
| “No captions found” | Enable captions (CC) in the meeting; wait a few seconds |
| Empty transcript | Reload the meeting tab after installing the extension |
| Captions stopped being captured | Google sometimes changes its page code — the selectors in `content.js` (`findMeetRoot`, `readMeetBlocks`) are the place to update |
| AI error 400/401 | Check the API key and model name in Settings |

## Privacy

- Captions never leave your browser except the single AI request you trigger.
- No account, no server, no analytics.
