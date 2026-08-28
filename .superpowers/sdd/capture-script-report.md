# capture-book-text.ts — build report

## Status: DONE

New standalone script: `src/capture-book-text.ts`. Bypasses the broken
metadata-endpoint scraping in `extract-kindle-book.ts` entirely: screenshots the
rendered Kindle web-reader page image (readable pixels, not the glyph-obfuscated
body text), then optionally OCRs each page PNG with the local `codex` CLI.

## What it does

1. Loads `.env` (`import 'dotenv/config'`); reads `ASIN` (asserted), `MAX_PAGES`
   (optional positive int, default 5), `OCR` (`1`/`true` to enable OCR),
   `CODEX_BIN` (default `codex`), `CODEX_MODEL` (optional), `CODEX_TIMEOUT_MS`
   (default 300000).
2. Launches the reader by **copying the extractor's exact proven setup**: same
   `userDataDir = out/<ASIN>/data` warm persistent profile, same
   `patchright chromium.launchPersistentContext(userDataDir, { headless:false, channel:'chrome', ... })`
   args/ignoreDefaultArgs/bypassCSP/deviceScaleFactor:2/viewport. Navigates to
   `https://read.amazon.com/?asin=<ASIN>`. If it lands on `/ap/signin` it runs
   the same login flow (email `input#continue`, password `input#signInSubmit`,
   terminal 2FA prompt) when creds are present, else prompts the user to sign in
   manually in the visible window. Warm profile means this is normally skipped.
3. Best-effort single-column layout (reused `Reader settings` +
   `Single Column` radiogroup selectors) and best-effort go-to-start via the
   reader's `Go to Page` modal → page `1` (reused `item-i-d="go-to-modal-go-button"`
   selector). If go-to-start fails it logs a warning and captures from the
   CURRENT reader position rather than hard-failing.
4. Capture loop (UI-level only, no private endpoints):
   - Screenshots `#kr-renderer .kg-full-page-img img` (falls back to
     `#kr-renderer`, then full viewport) to
     `out/<ASIN>/text-capture/page-####.png` (zero-padded, 1-based).
   - Advances via `ArrowRight` key; falls back to the `.kr-chevron-container-right`
     chevron if the key doesn't change the page. Waits for the main image `src`
     to change (with a fixed settle delay).
   - Computes a sha256 of each screenshot; stops when the last 3 consecutive
     screenshots are byte-identical (end of book) OR `MAX_PAGES` is hit OR the
     page fails to advance.
   - Resumable: skips any `page-####.png` that already exists (still advances the
     reader to stay in sync) and writes `capture-state.json` with the count.
5. OCR phase (only when `OCR=1`; capture-only otherwise so the user can capture
   first): for each `page-*.png` without a sibling `page-*.txt`, spawns
   `codex exec --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --sandbox read-only --cd <tmp> --image <ABS.png> --output-last-message <tmp/result.txt> --json "<prompt>"`
   with **stdin closed** (`stdio:['ignore','pipe','pipe']`), watching stdout JSONL
   for `turn.completed`. The result file is stat-bounded (8 MB cap, non-empty)
   before reading, written to `page-####.txt` (resumable), then all page texts
   are concatenated in order into `out/<ASIN>/book-text.md` with a
   `\n\n---\n\n` separator. Per-page OCR failures are logged and skipped without
   aborting the run.
6. Informative `[capture]` / `[ocr]` logging throughout (per-page capture/OCR,
   end-detection reason, final output path + page count + total characters).

## Verification

- `pnpm test:typecheck` (`tsc --noEmit`): **PASS**.
- `eslint src/capture-book-text.ts`: clean. `prettier --check`: clean.
- Script was NOT executed (needs the user's live browser/login); no
  `RUN_CODEX_INTEGRATION`.

## Constraints honored

- No new dependencies (reused patchright, @inquirer/prompts, delay, node
  crypto/child_process/fs/os, and `assert`/`fileExists`/`getEnv`/`parsePageNav`
  helpers from existing files).
- Did not modify existing pipeline files; the temp `[net-debug]` logging in
  `extract-kindle-book.ts` is left untouched (its unrelated working-tree edit was
  not staged).

## Assumptions the user should verify on first run

- **Go-to-start**: uses the `Go to Page` modal with page `1`. If the book's
  numbering starts on roman-numeral front matter or the modal rejects `1`, the
  first captured page may be off; the script logs which path it took. Verify
  `page-0001.png` is actually the start.
- **Next-page control**: `ArrowRight` requires the reader to hold keyboard focus;
  the `.kr-chevron-container-right` chevron is the fallback. Confirm pages
  actually advance on the first couple of captures.
- **Single-column layout** is best-effort; if the settings panel selectors have
  changed, layout stays as-is (capture still proceeds).

---

## Update — visual (figure/chart/formula) preservation in the OCR phase

The capture (browser screenshot) phase is unchanged. The OCR/analysis +
output-assembly phase now preserves and interprets VISUAL content so nothing
visual is lost.

### Per-page Codex call (now structured)
- `spawnCodex` adds `--output-schema <tmp schema.json>`; the prompt asks Codex to
  return `{ text, visuals[] }`. Each visual has `kind`
  (figure|chart|graph|diagram|formula|table|image|other), a DETAILED
  `description` (axes/series/trend/values for charts; the equation + what it
  computes for formulas; structure + key values for tables), and a normalized
  0..1000 `region` `{x,y,width,height}` or `null`.
- Schema is lenient but structured-output-strict-compliant
  (`additionalProperties:false`, all props required, `region` nullable via
  `type:["object","null"]`). The `--output-last-message` file is bounded-read
  then JSON-parsed; parse failure falls back to `{text: rawMessage, visuals: []}`
  so a page never hard-fails.

### Image preservation (Sharp — never lose a visual)
- Assets written to `out/<ASIN>/text-capture/assets/`.
- Each visual with a `region` is cropped (floor TL / ceil BR, clamped to real
  PNG pixel bounds, min 24px/side) to `page-####-fig-{id}.png` and verified to
  decode. If `region` is null, the crop is out of bounds/too small, or Sharp
  fails, it falls back to a full-page copy `page-####-full.png`.
- Any page with >=1 visual always gets `page-####-full.png` as a safety net.

### Output (`out/<ASIN>/book-text.md`)
Per page: the `text`, then for each visual an image embed
`![kind — first~80 chars](text-capture/assets/…)` immediately followed by a
blockquote `> **Kind (page n):** {full description}`, then a final
`> _Full page image:_ [page n](…)` line when the page had visuals. Pages are
separated by `\n\n---\n\n`.

### Resumability
- Each page's parsed result persists to `text-capture/page-####.json`; a rerun
  reuses it (skips Codex) but still (re)generates crops and rebuilds the whole
  `book-text.md` from the per-page JSON, so output is deterministic. (Replaces
  the old per-page `.txt`.)
- Logs per page: text chars, visual count, and each asset written.

### Verification
- `pnpm exec tsc --noEmit`: PASS. `pnpm exec eslint src/capture-book-text.ts`:
  clean. `prettier --check`: clean. No new dependencies (reused existing
  `sharp`). Script NOT executed (needs live browser); no RUN_CODEX_INTEGRATION.

### Assumption to verify on a real run
- Crop accuracy depends on Codex's bounding boxes. If a box is loose/off, the
  crop may clip or over-include; the full-page image is always linked as a
  safety net, and null/too-small/failed regions degrade to the full page — so a
  visual is never lost even when localization is imperfect. The safety-net link
  points at the real copied file `text-capture/assets/page-####-full.png` (the
  spec example wrote `text-capture/page-####-full.png` without `assets/`, which
  would not resolve); confirm this path choice is acceptable.
