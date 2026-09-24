#!/bin/sh
# GUI-launched Claude Code may not inherit nvm/asdf/Homebrew PATH.
case "$1" in heartbeat.js|session-end.js) ;; *) exit 2 ;; esac
usagex_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
usagex_saved_node=
if [ -r "$HOME/.usagex/node-path" ]; then IFS= read -r usagex_saved_node < "$HOME/.usagex/node-path"; fi
for usagex_node in "${USAGEX_NODE:-}" "$usagex_saved_node" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.volta/bin/node" "$HOME/.local/share/mise/shims/node" "$HOME/.asdf/shims/node" "$HOME"/.nvm/versions/node/*/bin/node; do
  if [ -n "$usagex_node" ] && [ -x "$usagex_node" ]; then exec "$usagex_node" "$usagex_root/hooks/$1"; fi
done
printf '%s\n' 'UsagEX: Node.js 18+ was not found. Set USAGEX_NODE to its full executable path or reinstall standalone hooks.' >&2
exit 1
