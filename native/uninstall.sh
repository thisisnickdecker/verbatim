#!/bin/sh
# Remove Verbatim's save helper. Captures go back to Downloads/Verbatim.
set -eu
rm -f "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.nickdecker.verbatim.json"
rm -f "$HOME/.verbatim/config.json"
echo "Removed. Verbatim will save to Downloads/Verbatim."
