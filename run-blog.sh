#!/bin/sh
# Nightly blog (cron at 21:00 and 22:00 UTC; blog.mjs --nightly only acts at 22:xx Europe/London, once a day).
cd "$(dirname "$0")"
export PATH="$HOME/.local/node22/bin:$PATH"
mkdir -p "$HOME/logs"
exec node blog.mjs --nightly >> "$HOME/logs/bwalletx-blog.log" 2>&1
