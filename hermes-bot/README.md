# Hermes Bot

Talk to your own [Hermes Agent](https://hermes-agent.nousresearch.com/)
from Rokid Glasses. Ask by voice; the reply streams onto the display and is
read aloud, then it listens again so you can keep the conversation going.

See the [main README](../README.md) for requirements, installing on the
glasses, the key and Tailscale.

## Using it

| You do | It does |
|---|---|
| "Hi Rokid, open Hermes Bot" | Opens on your last exchange and starts listening. |
| Speak | Sends it once you've been quiet for about 3 seconds (short pauses are fine). |
| Tap the temple | Talk now · send now (while listening) · cancel (while thinking) · interrupt a spoken reply and talk. |
| Swipe | Next / previous page of a long reply; before page 1, earlier exchanges. While it's listening, a swipe stops listening (nothing is sent) so you can read. |
| Swipe past the last page | Opens the **menu**. |
| Double tap (Back) | Steps out of a submenu, or closes the app. |

**Menu:** Talk · Earlier replies › (this conversation, newest first) · New
conversation · Past conversations › · Quick asks › (weather, headlines) ·
More › (repeat last reply, ask again, Fast/Smart mode, Settings › (speak
replies, keep listening, scan setup QR), close).

**Voice commands** (say them instead of a question):

- "new conversation" / "new chat" / "start over": a fresh conversation.
  Shorter history means faster replies.
- "smart mode" / "fast mode": switch model (see below).
- "scan" / "setup": reopen the QR scanner.

**Replies are kept short.** Every request tells your agent it is answering on
glasses: very short replies, no markdown, and that your words come from
speech-to-text, so it should work out misheard words, say up front if it
assumed something ("Assuming you meant Paris: …"), or ask one short
question. This is sent as the request's `instructions`
(`GLASSES_INSTRUCTIONS` in `lib/hermes.js`), so your agent's own settings
don't change.

**History:** the glasses keep your last 10 conversations (30 exchanges each)
so the app opens where you left off. Hermes keeps the full history on your
Mac, so resuming a past conversation continues it with its context.

## Set up your Mac

1. **Turn on Hermes' API server**, bound to this Mac only. In
   `~/.hermes/.env`:

   ```bash
   API_SERVER_ENABLED=true
   API_SERVER_HOST=127.0.0.1
   API_SERVER_PORT=8642
   API_SERVER_KEY=<a long random value: openssl rand -hex 32>
   ```

   Restart Hermes' gateway so it picks this up (however you run it, for
   example stop and start `hermes gateway`).

2. **Make it reachable on your tailnet** (tailnet devices only, no internet):

   ```bash
   tailscale serve --bg --http=8461 http://127.0.0.1:8642
   ```

   Plain `http` is deliberate: the Hi Rokid app sends requests as plain
   HTTP, and the tailnet already encrypts the connection.

3. **Show the setup QR code** when the app asks for it:

   ```bash
   rokid-utils/hermes-bot-qr
   ```

### Optional: fast and smart models

The app asks for the model `glasses` (fast mode) or `glasses-smart` (smart
mode). If your Hermes config has no routes with those names, both use your
agent's normal model. To pick models for the glasses, add routes to
`~/.hermes/config.yaml` and restart Hermes:

```yaml
platforms:
  api_server:
    model_routes:
      glasses:          # fast mode: pick your quickest model
        model: <fast-model>
        provider: <provider>
      glasses-smart:    # smart mode: slower, more careful
        model: <smart-model>
        provider: <provider>
```

Fast mode also turns the model's thinking step off
(`reasoning_effort: "none"`), which saved about a second per reply in
testing. A short, quick model makes the glasses feel much better than a
smart, slow one.

## How it works

- `POST /v1/responses` on your Hermes API server, streamed, with a named
  `conversation` so Hermes keeps the history. Tool use shows as "Using …".
- Cancel closes the stream, so Hermes stops the turn too.
- `lib/listen.js` keeps listening across pauses: the glasses' recognizer
  stops at the first pause, so a new segment is started and the words are
  joined. Tune `PAUSE_MS` there.
- Nothing scrolls from code on the glasses, so long replies are split into
  pages (`LINE_UNITS` and `PAGE_ROWS` in the page set the size).
- Settings (URL, key, conversation, modes) and history live in the glasses'
  local storage, never in the package.

## Developing

- `npx @yodaos-pkg/aix-cli show .` checks the app definition;
  `npx @yodaos-pkg/aix-cli pack . -o /tmp/hermes-bot.aix` builds a package.
- `npx @yodaos-pkg/aix-cli preview --dev .` runs Rokid's web simulator (no
  microphone or camera, and it can't reach your tailnet, so it's for layout
  and keys only).
- Bump `version` in `app.json`, `lib/version.js` and `AGENTS.md` together
  (`rokid-utils/check-versions` checks they match).

## Not yet verified on the glasses

- Speak-then-listen timing: Rokid has no "finished speaking" event, so
  `lib/speak.js` watches the audio player with a backup timer.
- Restarting recognition right after a pause (`lib/listen.js`): if the
  glasses refuse, it sends what it heard so far.
- Requests passed in by Rokid's assistant ("Hi Rokid, ask Hermes Bot …") or
  an AI Shortcut, via the page's `prompt` input.
