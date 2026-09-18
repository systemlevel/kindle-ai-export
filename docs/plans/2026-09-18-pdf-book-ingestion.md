# PDF book ingestion

Add a separate `src/capture-pdf-text.ts` entry point. Keep Kindle capture and the shared analyzer unchanged. Render every physical PDF page to PNG with Poppler, then use the existing vision analyzer so scanned text, tables, graphs, diagrams, and illustrations receive the same processing as Kindle screenshots.

## Implementation

1. Add a small Poppler adapter, with real-PDF coverage for inspection and rendering.
2. Add PDF-only configuration, output folders, source snapshots, and an atomic capture manifest. Bind resumable caches to the source SHA-256, page count, resolution, and individual image hashes. Refuse existing Kindle folders and changed sources/settings. Serialize writes with a per-book lock.
3. Add the entry point with full-book processing, `CAPTURE_ONLY`, and `ANALYZE_ONLY`, followed by existing analyzer preflight and analysis. Propagate partial analysis failures as a failing command while preserving successful pages for retries.
4. Document setup, invocation, outputs, scanned/graphic pages, resumability, and provider configuration. Add tests for protected Kindle folders, source/settings mismatch, interrupted capture, page ordering, and analysis failure behavior.
5. Run TypeScript checks, the complete existing/new test suite, and a real PDF capture-only smoke test. Confirm the Kindle capture script and shared pipeline are byte-for-byte unchanged.

## Defaults and scope

- Source: one positional PDF path, or `PDF_FILE`.
- Destination: `out/pdf-<filename>-<source-hash-prefix>`; optional simple folder name via `PDF_BOOK`. Ignore the Kindle-specific `BOOK` selector.
- Render at 150 DPI by default; `PDF_DPI` accepts 72–600.
- Full-book analysis by default; existing explicit analysis filters remain available.
- Existing Codex/Claude backends and image/crop semantics apply without new model calls or prompt changes.
- Poppler must be installed (`brew install poppler` / `apt-get install poppler-utils`). Password-protected unreadable PDFs fail clearly; no password capture or automatic unlock.

## Validation

Before changes, TypeScript validation passed. Final verification includes the full existing suite, focused PDF tests, TypeScript checks, targeted lint, and a real PDF capture-only smoke test. Analyzer tests use fixture CLIs; they do not invoke paid models.
