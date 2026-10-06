#!/bin/sh
# Daily queue post (cron at 09:00 and 10:00 UTC; xpost.mjs --daily only acts at 10:xx Europe/London, once a day).
cd "$(dirname "$0")"
export PATH="$HOME/.local/node22/bin:$PATH"
exec node xpost.mjs --post --daily >> "$HOME/logs/bwalletx-x.log" 2>&1
