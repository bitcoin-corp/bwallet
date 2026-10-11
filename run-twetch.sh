#!/bin/sh
# Paced Twetch posting (cron every 3 hours; xpost.mjs --paced only posts if the pace interval has passed).
cd "$(dirname "$0")"
export PATH="$HOME/.local/node22/bin:$PATH"
exec node xpost.mjs --post --twetch-only --paced >> "$HOME/logs/bwalletx-x.log" 2>&1
