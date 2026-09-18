#!/bin/zsh
# Reprocess with Fable only the pages of one book that do not yet have a Fable result.
SP="${SP:-$HOME/kindle-fable-logs}"; mkdir -p "$SP/books"
REPO="/Users/darrenlabrum/Library/Mobile Documents/com~apple~CloudDocs/Workspace/Books/kindle-ai-export"
book="$1"; cd "$REPO" || exit 1
pages=$(python3 "$REPO/scripts/pages-missing-fable.py" "out/$book" 2>>"$SP/books/summary.log")
if [ -z "$pages" ]; then echo "$(date '+%F %T') SKIP $book :: all pages already Fable" >> "$SP/books/summary.log"; exit 0; fi
log="$SP/books/${book}.resume.log"; start=$(date +%s)
echo "$(date '+%F %T') START(resume) $book :: PAGES=$pages" >> "$SP/books/summary.log"
BOOK="$book" ANALYZER=claude CLAUDE_CLI_MODEL=claude-fable-5-1 REPROCESS=1 PAGES="$pages" npx tsx src/analyze-book-text.ts > "$log" 2>&1
rc=$?; mins=$(( ($(date +%s) - start) / 60 ))
result=$(grep -o '\[analyze\] finished.*' "$log" | tail -1 | sed 's/ -> .*//' | cut -c1-160)
limit=$(grep -c 'duration_api_ms":0' "$log")
echo "$(date '+%F %T') DONE(resume) rc=$rc ${mins}min $book :: $result :: limit-failures=$limit" >> "$SP/books/summary.log"
