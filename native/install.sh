#!/bin/sh
# Install Verbatim's optional save helper for Google Chrome on macOS.
#
#   native/install.sh <extension-id> "<save folder>"
#
# The extension ID is shown on Verbatim's card in chrome://extensions
# (Developer mode). The save folder can be any folder, e.g. one in your
# Obsidian vault. Run again to change either; native/uninstall.sh removes it.
set -eu

ID="${1:?usage: install.sh <extension-id> \"<save folder>\"}"
FOLDER="${2:?usage: install.sh <extension-id> \"<save folder>\"}"
HERE="$(cd "$(dirname "$0")" && pwd)"
HOST="$HERE/verbatim_host.py"
MANIFESTS="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

[ -d "$FOLDER" ] || { echo "Folder not found: $FOLDER" >&2; exit 1; }
chmod +x "$HOST"
mkdir -p "$MANIFESTS" "$HOME/.verbatim"

python3 - "$FOLDER" "$HOME/.verbatim/config.json" <<'EOF'
import json, sys
json.dump({"saveFolder": sys.argv[1]}, open(sys.argv[2], "w"), indent=2)
EOF

cat > "$MANIFESTS/com.thestudiolo.verbatim.json" <<EOF
{
  "name": "com.thestudiolo.verbatim",
  "description": "Verbatim save helper",
  "path": "$HOST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
EOF

echo "Installed. Verbatim captures will be saved to: $FOLDER"
echo "Reload Verbatim in chrome://extensions to start using it."
