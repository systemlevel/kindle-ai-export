#!/bin/zsh
# Probe the Fable model every 10 minutes; when it answers, resume the given books (3-wide) on their remaining pages.
REPO="/Users/darrenlabrum/Library/Mobile Documents/com~apple~CloudDocs/Workspace/Books/kindle-ai-export"
export SP="${SP:-$HOME/kindle-fable-logs}"; mkdir -p "$SP/books"
books=("$@")
echo "$(date '+%F %T') WAITING for Fable to clear; books: ${books[*]}" >> "$SP/books/summary.log"
while true; do
  out=$(echo "Reply with the single word OK." | env -u CLAUDECODE claude -p --output-format json --model claude-fable-5-1 --no-session-persistence --strict-mcp-config 2>&1)
  if echo "$out" | grep -q '"is_error":false'; then echo "$(date '+%F %T') FABLE CLEARED" >> "$SP/books/summary.log"; break; fi
  sleep 600
done
for b in "${books[@]}"; do
  while [ "$(pgrep -f 'node .*tsx src/analyze-book-text.ts' | wc -l | tr -d ' ')" -ge 3 ]; do sleep 60; done
  "$REPO/scripts/run-one-book-resume.sh" "$b" &
  sleep 30
done
wait
echo "$(date '+%F %T') WAIT-RESUME QUEUE COMPLETE" >> "$SP/books/summary.log"
