# Rokid Glasses bots: Hermes Bot, Claude Bot and WhatsApp Bot

Three apps (AIUI agents) for **Rokid Glasses** that let you use your own AI
agents hands-free, by voice and the temple touchpad:

- **[Hermes Bot](hermes-bot/README.md)**: talk to your own
  [Hermes Agent](https://hermes-agent.nousresearch.com/). Ask by voice;
  the reply appears on the display and is read aloud.
- **[Claude Bot](claude-bot/README.md)**: browse the
  [Claude Code](https://claude.com/claude-code) sessions on your Mac by
  project, read them, and reply by voice, run slash commands, stop a reply
  or start a new session.
- **[WhatsApp Bot](whatsapp-bot/README.md)**: read your recent WhatsApp
  chats and reply by voice, or ask Rokid's assistant to "send a WhatsApp to
  Mom saying I'm on my way". Every message waits for your tap before it's
  sent. Uses an unofficial WhatsApp client: [read the risks](whatsapp-bot/README.md)
  first.

All three run on the glasses and talk to software on **your own Mac**, privately
over [Tailscale](https://tailscale.com). Nothing goes through a server of
ours; there isn't one.

```
Rokid Glasses ──Bluetooth──▶ Hi Rokid app on your phone ──Tailscale──▶ your Mac
                                                                      ├─ Hermes Agent API      (Hermes Bot)
                                                                      ├─ claude-bridge ─▶ claude (Claude Bot)
                                                                      └─ whatsapp-bridge ─▶ WhatsApp (WhatsApp Bot)
```

> **Unofficial.** This project is not made by or affiliated with Rokid, Nous
> Research, Anthropic, WhatsApp/Meta or Tailscale; their names are their trademarks (see
> [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). It is a developer
> build, not a store app. MIT licensed ([LICENSE](LICENSE)).

## What you need

**Glasses and phone**

- **Rokid Glasses** (the AI glasses with a display, running YodaOS-Sprite).
  Developed and tested on the RV101 model; other models may need tweaks to
  key handling and text size.
- The **Hi Rokid** app on your phone (iOS or Android), signed in and paired
  with the glasses.
- The **Tailscale** app on the same phone, signed in to your tailnet.
- **The glasses' Wi-Fi turned off.** With Wi-Fi off, the glasses send every
  request through the Hi Rokid app on your phone, and Tailscale on the phone
  carries it to your Mac. On Wi-Fi they go straight to the internet and
  cannot reach your tailnet.

**To install the apps**

- A **Rokid account** with access to **AIUI Studio Global**
  (<https://aiui-global.rokid.com/>), used in **Google Chrome** (it reads
  the app folder from your disk).
- No cable: apps go to the glasses through AIUI Studio and the Hi Rokid app.
  (The `aix install` command needs Rokid's separate development cable; the
  charging cable carries no data.)

**On your Mac** (the "server")

- **macOS** with **Tailscale** installed and signed in to the same tailnet,
  with **MagicDNS** on (the default; the setup QR uses your Mac's tailnet
  name).
- The **`tailscale` command**. The Tailscale app from the App Store or
  tailscale.com doesn't add it by default: in the app, open **Settings →
  Install CLI** (or `brew install tailscale`). Check with
  `tailscale status`.
- **qrencode** for the setup QR codes: `brew install qrencode`.
- **Python 3** (comes with macOS developer tools) for the QR helpers.
- For **Hermes Bot**: [Hermes Agent](https://hermes-agent.nousresearch.com/)
  running, with its API server turned on.
- For **Claude Bot**: **Node.js 20+** and the **Claude Code CLI** (`claude`)
  installed and signed in.
- For **WhatsApp Bot**: **Node.js 20+** with **npm**, and WhatsApp on your
  phone to link the Mac as a linked device.
- The Mac must be **on and awake** when you use the glasses: for example
  System Settings → Battery (or Energy) → **Prevent automatic sleeping when
  the display is off** on power, or run `caffeinate -s` while you're out.

## Install, step by step

0. **Get the code** on your Mac and open a terminal in it. All
   `rokid-utils/…` commands below run from this folder:

   ```bash
   git clone https://github.com/flaibot/rokid-glasses-bots
   cd rokid-glasses-bots
   ```

   The bridge's background service remembers this folder's location; if you
   move it, run `rokid-utils/install-bridge-service` again.
1. **Set up the Mac side** for the bot(s) you want:
   [Hermes Bot setup](hermes-bot/README.md#set-up-your-mac) ·
   [Claude Bot setup](claude-bot/README.md#set-up-your-mac) ·
   [WhatsApp Bot setup](whatsapp-bot/README.md#set-up-your-mac).
2. **Put the app on the glasses** (same for each):
   1. In Chrome, open AIUI Studio Global → **New Agent** → **Import from
      local folder** → choose the app folder (`hermes-bot`, `claude-bot` or
      `whatsapp-bot`)
      and allow access.
   2. Open the agent → **Build & Review** → **AIX Packaging** → **Package
      AIX**. Wait until the agent shows **Synced** in the left sidebar. This
      does not submit anything to Rokid's store.
   3. On the glasses' main view: **Glasses Settings → Developer → AIUI →
      Update glasses resources**. A small antenna icon flashes in the bottom
      right; the app is then installed. (If there's no **Developer** entry,
      check Rokid's AIUI docs for turning on developer options for your
      model.)
3. **Connect it:** say "Hi Rokid, open Hermes Bot" (or "… Claude Bot",
   "… WhatsApp Bot"). The first time it opens the QR scanner. On the Mac run
   [`rokid-utils/hermes-bot-qr`](rokid-utils/README.md) (or
   `claude-bot-qr`, `whatsapp-bot-qr`), look at the code on the screen and
   tap the temple.

**Updating an app:** in AIUI Studio, open the agent's **⋯** menu → **Import
from local folder** (Studio packages its own stored copy, not your folder,
so re-import after every change) → **Build & Review → AIX Packaging →
Repackage AIX**, then **Update glasses resources** on the glasses. Each app
shows its version in small text, so you can check the update arrived.
Never use **Overwrite local files**: it copies Studio's old copy over yours.

## The keys, and why Tailscale

Each bot uses one secret key, and **each key is powerful**:

| Key | Where it lives | What it unlocks |
|---|---|---|
| Hermes `API_SERVER_KEY` | `~/.hermes/.env` on the Mac | Your Hermes agent with **all its tools**, including running terminal commands on your Mac. |
| Claude bridge token | `~/.claude-bridge/config.json` on the Mac (created on first run, file mode 600) | Sending prompts to **Claude Code** in any of your project folders, which can edit files and run commands. |
| WhatsApp bridge token | `~/.whatsapp-bridge/config.json` on the Mac (created on first run, file mode 600) | Reading your recent **WhatsApp** messages and sending messages **as you**. |
| WhatsApp linked-device session | `~/.whatsapp-bridge/auth/` on the Mac (folder mode 700) | Not a key you hand out, but equivalent to **access to your WhatsApp account**, like a logged-in WhatsApp Web. Never copy or share it. |

How the keys are handled:

- **The key never goes into the app package.** You hand it to the glasses
  once by scanning a QR code on your Mac's screen; the glasses keep it in
  their local storage. Packages you upload to AIUI Studio contain no keys.
- Anyone who can photograph the QR code gets the key. Show it only to your
  glasses and close it afterwards.
- **Rotating a key:** Hermes: put a new `API_SERVER_KEY` in `~/.hermes/.env`
  (`openssl rand -hex 32`) and restart Hermes' gateway however you run it
  (for example stop and start `hermes gateway`). Bridge: delete the `token`
  line from `~/.claude-bridge/config.json` and run
  `rokid-utils/install-bridge-service` to restart it; a new token is
  generated. WhatsApp bridge: the same, in `~/.whatsapp-bridge/config.json`,
  then `rokid-utils/install-bridge-service --whatsapp`. Then show the new
  QR and say "scan" (Hermes Bot) or choose **Scan setup QR code** (Claude
  Bot, WhatsApp Bot).
- **Ending the WhatsApp session:** on your phone, WhatsApp → Settings →
  Linked devices → the bridge → **Log out**. The bridge deletes its session
  and stored messages (see [Unlinking](whatsapp-bot/README.md#unlinking)).

**Use Tailscale. Strongly.** All three services listen only on `127.0.0.1` on
your Mac and are reached through `tailscale serve`, which:

- opens **no ports** on your router or to the internet;
- only accepts devices **signed in to your tailnet**, so a stranger needs
  both your tailnet and the key;
- encrypts everything between your phone and Mac (WireGuard), which is why
  plain `http://` inside the tailnet is fine.

Do **not** expose these services to the internet: no router port forwarding,
no Tailscale **Funnel**, no public tunnel. A leaked key on a public URL is
remote control of your computer.

The first `tailscale serve` may ask you to allow Serve for your tailnet;
follow the link it prints. For extra safety, let only your phone reach the
ports with a Tailscale access rule (admin console → Access controls).
Note that once you add rules, anything not allowed is blocked, so keep or
add rules for your other devices too:

```jsonc
{
  "hosts": {
    "my-mac": "100.x.y.z",    // tailscale ip -4 on the Mac
    "my-phone": "100.a.b.c"   // the phone's address in the Tailscale app
  },
  "acls": [
    { "action": "accept", "src": ["my-phone"], "dst": ["my-mac:8461,8463,8465"] }
    // ...your other rules
  ]
}
```

## Repository layout

| Folder | What |
|---|---|
| [`hermes-bot/`](hermes-bot/README.md) | The Hermes Bot app (AIUI agent). |
| [`claude-bot/`](claude-bot/README.md) | The Claude Bot app (AIUI agent). |
| [`whatsapp-bot/`](whatsapp-bot/README.md) | The WhatsApp Bot app (AIUI agent). |
| `claude-bridge/` | The small server on your Mac that Claude Bot talks to (Node, no dependencies). |
| `whatsapp-bridge/` | The small server on your Mac that WhatsApp Bot talks to (Node, one dependency: Baileys). |
| [`rokid-utils/`](rokid-utils/README.md) | Setup QR codes, WhatsApp linking, the bridge service installer, and a version check. |

## Troubleshooting

**`hyper: Error(BodyWrite … send failed status=100002)` or
`IncompleteMessage` on the glasses:** the request never reached your Mac.
Check, retrying after each:

1. The **Hi Rokid app is open** on the phone, ideally in the foreground, with
   the glasses connected. Phones pause it in the background.
2. The **glasses' Wi-Fi is off**, and your home network is forgotten on the
   glasses so they don't rejoin it.
3. **Tailscale is connected** on the phone.
4. The Mac is **on, awake and connected** to Tailscale, and its tailnet name
   hasn't changed since you scanned the QR code (`tailscale status`). If it
   changed, show the QR again and rescan.

**"Key rejected":** the key changed on the Mac. Show the QR again and scan.

**WhatsApp Bot says "not linked" or "reconnecting":** run
`rokid-utils/whatsapp-link` (it says if it's already linked), and check
`~/.whatsapp-bridge/bridge.log`. WhatsApp logs linked devices out when your
phone has been offline for about 14 days.

**The app on the glasses is an old version:** re-import the folder in AIUI
Studio before repackaging (see Updating above).

## Known limits

- Developer builds only: publishing to Rokid's Agent Store needs Rokid's
  review and a registered list of request domains, which a self-hosted Mac
  can't provide.
- Some behaviour depends on Rokid's runtime and was only tested in a
  simulator or with mocks; each app's README lists what is unverified.
- Installed apps can't be removed from the glasses (Rokid offers no
  uninstall short of a reset), so pick the agent names you want to keep.
