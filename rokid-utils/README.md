# rokid-utils

Small helpers for the Rokid Glasses bots. Run them on the Mac that hosts
Hermes and the Claude and WhatsApp bridges.

| Script | What it does |
|---|---|
| `hermes-bot-qr [--terminal]` | Shows the Hermes Bot setup QR code: your Mac's tailnet URL for Hermes (port 8461 by default) and your Hermes `API_SERVER_KEY`. |
| `claude-bot-qr [--terminal]` | Shows the Claude Bot setup QR code: the bridge's tailnet URL (port 8463 by default) and its token. |
| `whatsapp-bot-qr [--terminal]` | Shows the WhatsApp Bot setup QR code: the WhatsApp bridge's tailnet URL (port 8465 by default) and its token. |
| `whatsapp-link [--preview]` | Links the WhatsApp bridge to your WhatsApp account: shows WhatsApp's pairing code until your phone has scanned it (WhatsApp → Settings → Linked devices → Link a device). |
| `install-bridge-service [--whatsapp] [--uninstall]` | Installs (or removes) the Claude bridge, or with `--whatsapp` the WhatsApp bridge, as a macOS background service that starts at login. |
| `check-versions` | Checks each app's `app.json` version matches the version shown on the glasses (`lib/version.js`) and `AGENTS.md`. |

The QR scripts need `qrencode` (`brew install qrencode`) and Tailscale
running. They open the code in Preview, which is easiest for the glasses'
camera; `--terminal` prints it instead. **The QR code contains your key**:
show it only to your glasses and close it afterwards.

Settings are environment variables, described at the top of each script
(for example `HERMES_BOT_PORT`, `CLAUDE_BOT_URL`, `CLAUDE_BRIDGE_LABEL`,
`WHATSAPP_BRIDGE_HOME`).
Run the scripts from the repository root, e.g. `rokid-utils/hermes-bot-qr`.

`whatsapp-link` talks to the WhatsApp bridge on `127.0.0.1` with the token
from `~/.whatsapp-bridge/config.json`, so it only works on the Mac itself.
