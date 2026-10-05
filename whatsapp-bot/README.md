# WhatsApp Bot

Read your recent WhatsApp chats on Rokid Glasses and reply by voice. Also
lets Rokid's assistant send a message for you: "Hi Rokid, send a WhatsApp
to Mom saying I'm on my way" finds Mom, shows the message, and sends it
when you tap.

It talks to a small **WhatsApp bridge** on your own Mac, which is linked to
your WhatsApp account as a linked device (like WhatsApp Web). See the
[main README](../README.md) for requirements, installing on the glasses,
the keys and Tailscale.

> **Read this first: risks**
>
> - The bridge uses [Baileys](https://github.com/WhiskeySockets/Baileys),
>   an **unofficial** WhatsApp Web client. WhatsApp doesn't allow
>   unofficial clients and **may restrict or ban numbers that use them**.
>   Use it on a number you can afford to lose, or accept that risk.
>   Light personal use (reading, a few replies) is the least likely to be
>   flagged; the bridge never sends on its own, only text you confirmed on
>   the glasses, and at most 10 messages a minute.
> - The bridge's session (`~/.whatsapp-bridge/auth/`) **is access to your
>   WhatsApp account**, and its token lets anyone holding it read your
>   recent messages and send messages as you. Both stay on your Mac; keep
>   the bridge on Tailscale only.
> - Your messages stay on your Mac: the bridge keeps the latest 50 text
>   messages of your 200 most recent chats in `~/.whatsapp-bridge/store.json`
>   (readable by your user only). Photos, voice notes and files are never
>   downloaded; they show as "[photo]", "[voice note]"….

## Using it

| You do | It does |
|---|---|
| "Hi Rokid, open WhatsApp Bot" | Opens your chats, newest first. ● and a count mark unread chats. |
| Swipe (chats) | Moves one row; tap opens the chat. |
| Swipe (in a chat) | Previous / next page. A chat opens on its newest messages. |
| Tap (in a chat) | Opens the **menu**: Reply by voice · Latest · Refresh · Quick replies › · Back to chats. Reply is preselected, so tap-tap starts a reply. |
| Speak your reply | Pause (about 3 seconds) or tap when done. |
| Confirm screen | Shows **who** and **what**. Tap sends; swipe cancels. Nothing is sent without this tap. |
| **✎ New message** (top of the chats list) | Say who and what: "Mom, on my way" or "John saying see you at 8". |
| Double tap (Back) | Steps back: menu → chat → chats → closes the app. |

**Quick replies:** On my way · OK · Thanks! · Running late, be there soon ·
Can I call you later? · Yes · No. They also go through the confirm screen.

**Asking Rokid's assistant.** The app tells Rokid it handles sending and
reading WhatsApp messages, so you can say, for example:

- "Hi Rokid, send a WhatsApp to Mom saying I'm on my way"
- "… message John on WhatsApp that the meeting moved to 3"
- "… tell Sarah on WhatsApp I'll call later"
- "… read my WhatsApp messages" / "… any WhatsApp messages from Mom?"

Names are matched loosely, because speech-to-text mishears them: "mum"
finds "Mom", "jon" finds "John". When one contact clearly matches, the
confirm screen says what it heard ("Send to Mom (heard "mum")?"); when
several could fit, you pick from a short list. If the message part is
missing ("message Mom"), it listens for it.

Opening a chat marks it read, on WhatsApp too (blue ticks), as opening it
on your phone would. To keep that to the glasses, set
`"sendReadReceipts": false` in `~/.whatsapp-bridge/config.json` and restart
the bridge.

New messages show up by themselves: an open chat refreshes every 8
seconds and the chats list every 20.

## Set up your Mac

You need Node.js 20+ (with npm), Tailscale and `qrencode`; see the
[main README](../README.md#what-you-need).

1. **Start the bridge** as a background service (installs its one
   dependency, Baileys, the first time):

   ```bash
   rokid-utils/install-bridge-service --whatsapp
   ```

   It creates `~/.whatsapp-bridge/` with a new token, and listens on
   `127.0.0.1:8792` only.

2. **Link WhatsApp.** Run the following, then on your phone open
   WhatsApp → **Settings → Linked devices → Link a device** and scan the
   code in the terminal (it refreshes by itself):

   ```bash
   rokid-utils/whatsapp-link
   ```

   Your recent chats arrive over the next minute or two. Keep the phone
   online now and then: WhatsApp logs out linked devices when the phone
   has been offline for about 14 days.

3. **Make it reachable on your tailnet** (tailnet devices only, no
   internet):

   ```bash
   tailscale serve --bg --tcp=8465 tcp://127.0.0.1:8792
   ```

4. **Install the app** on the glasses (see the
   [main README](../README.md#install-step-by-step)), open it, and scan the
   setup QR code:

   ```bash
   rokid-utils/whatsapp-bot-qr
   ```

### Bridge settings

`~/.whatsapp-bridge/config.json` (restart the bridge after a change:
`rokid-utils/install-bridge-service --whatsapp`):

| Setting | Default | What |
|---|---|---|
| `token` | random | The key the glasses use. Delete the line and restart for a new one, then rescan. |
| `port` | `8792` | Local port (match it in `tailscale serve`). |
| `sendReadReceipts` | `true` | Opening a chat on the glasses marks it read on WhatsApp too. |
| `deviceName` | `Rokid Glasses bridge` | The name under WhatsApp → Linked devices (set before linking). |

### Unlinking

On your phone: WhatsApp → **Settings → Linked devices** → the bridge →
**Log out**. The bridge then deletes its session and stored messages by
itself. To remove everything:

```bash
rokid-utils/install-bridge-service --whatsapp --uninstall
rm -rf ~/.whatsapp-bridge
tailscale serve --tcp=8465 off
```

## How it works

- `whatsapp-bridge/server.mjs` (Node, one dependency: Baileys, pinned in
  `package-lock.json`; install scripts are turned off in `.npmrc`):
  - `GET /api/chats`, `GET /api/chats/:id/messages`: from its store,
    filled by WhatsApp's recent-history sync and new messages.
  - `GET /api/contacts?q=`: loose name matching (`match.mjs`).
  - `POST /api/send {jid, text}`: text only, to chats and contacts it
    already knows, at most 10 a minute.
  - `POST /api/read {jid}`, `GET /api/health`, `POST /api/link` (used by
    `whatsapp-link`).
  - Every request needs the token; it listens on 127.0.0.1 only.
- While not linked, the bridge stays idle; it only asks WhatsApp for
  pairing codes for 3 minutes after `whatsapp-link` asks.
- It doesn't show you as "online" while connected, so your phone keeps
  getting notifications.
- On the glasses, `lib/intent.js` turns a spoken request into who and what;
  `lib/ui.js` pages chats (nothing scrolls on the glasses).

## Developing

- Tests: `node lib/intent.test.mjs`, `node lib/ui.test.mjs` (here) and
  `node match.test.mjs` (in `whatsapp-bridge/`). They're left out of the
  package by `.aixignore`.
- `npx @yodaos-pkg/aix-cli show .` checks the app definition;
  `npx @yodaos-pkg/aix-cli pack . -o /tmp/whatsapp-bot.aix` builds a
  package.
- Try the bridge without touching your real one:
  `WHATSAPP_BRIDGE_HOME=/tmp/wa-test node ../whatsapp-bridge/server.mjs`
  (set a different `port` in `/tmp/wa-test/config.json` first).
- Bump `version` in `app.json`, `lib/version.js` and `AGENTS.md` together
  (`rokid-utils/check-versions` checks they match).

## Not yet verified on the glasses

This app is new: it was tested with a mocked bridge and the bridge was
tested up to showing a pairing code, but not yet end to end with a linked
account and real glasses.

- Rokid's assistant routing "send a WhatsApp to …" to this app, and passing
  the words in as `prompt` (the same mechanism as Hermes Bot's, also
  unverified). If it doesn't, open the app and use **✎ New message**.
- Message history after linking: how much WhatsApp sends depends on the
  phone.
- Names of contacts you've never chatted with: they come from WhatsApp's
  contact sync, which may be incomplete; those people may not be found by
  name.
