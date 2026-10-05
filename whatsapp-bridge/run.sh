#!/bin/zsh
# Starts the WhatsApp bridge (server.mjs next to this file) with Node.js 20+.
# Used by the background service (rokid-utils/install-bridge-service).
#
# Which Node: WHATSAPP_BRIDGE_NODE if set, else the newest nvm-installed Node,
# else `node` on the PATH. (fnm/volta/asdf users: set WHATSAPP_BRIDGE_NODE, or
# make sure `node` is on the service PATH.)
set -euo pipefail

node=${WHATSAPP_BRIDGE_NODE:-}
if [[ -z $node ]]; then
  # (N): no error when nvm isn't installed; (On): newest version first.
  candidates=(~/.nvm/versions/node/v{2,3}[0-9].*/bin/node(NOn))
  node=${candidates[1]:-}
fi
[[ -n $node ]] || node=$(command -v node || true)
[[ -n $node && -x $node && ! -d $node ]] || { print -u2 "whatsapp-bridge: Node.js 20 or newer is required (not found)"; exit 1; }

major=$("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || print 0)
(( major >= 20 )) || { print -u2 "whatsapp-bridge: Node.js 20 or newer is required ($node is version $major)"; exit 1; }

[[ -d ${0:A:h}/node_modules/@whiskeysockets/baileys ]] || { print -u2 "whatsapp-bridge: dependencies missing: run  npm ci  in ${0:A:h}"; exit 1; }

exec "$node" "${0:A:h}/server.mjs"
