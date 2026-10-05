# Third-party notices

This project includes code from others, under their own licenses:

| Code | Source | License |
|---|---|---|
| `*/lib/vendor/webpjs/` | WebPJS, the JavaScript WebP decoder by Dominik Homberger, as packaged in Rokid's AIUI samples | Same terms as WebM: [Software License Agreement](https://www.webmproject.org/license/software/) (BSD-style) and [Additional IP Rights Grant](https://www.webmproject.org/license/additional/). See `lib/vendor/webpjs/README.md`. |
| `*/lib/webp.js` | Adapted from the scanner sample in [Rokid's AIUI repository](https://github.com/yodaos-project/AIUI) | [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0); the file notes it was adapted |

The WhatsApp bridge (`whatsapp-bridge/`) doesn't include third-party code,
but `npm ci` installs its dependencies on your Mac, each under its own
license (pinned in `whatsapp-bridge/package-lock.json`):

| Package | License |
|---|---|
| [Baileys](https://github.com/WhiskeySockets/Baileys) (`@whiskeysockets/baileys`), an unofficial WhatsApp Web client | MIT |
| [libsignal-node](https://github.com/WhiskeySockets/libsignal-node) (`libsignal`), installed by Baileys | **GPL-3.0** |
| Other packages installed by Baileys | MIT, BSD-3-Clause, ISC, Apache-2.0, BlueOak-1.0.0, 0BSD |

Running the bridge combines it with libsignal-node at run time on your
Mac. If you redistribute the bridge together with its `node_modules`,
GPL-3.0 terms apply to that combined distribution.

Everything else is under the MIT License in `LICENSE`.

## Trademarks

Rokid, Hi Rokid and YodaOS are trademarks of Rokid. Claude and Claude Code
are trademarks of Anthropic. Hermes Agent is a project of Nous Research.
WhatsApp is a trademark of WhatsApp LLC (Meta).
Tailscale is a trademark of Tailscale Inc. They are used here only to say
what this software works with; this project is not affiliated with or
endorsed by any of them.
