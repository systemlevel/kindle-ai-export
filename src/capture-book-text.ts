/* eslint-disable no-process-env */
import 'dotenv/config'

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { input } from '@inquirer/prompts'
import delay from 'delay'
import { chromium } from 'patchright'

import {
  createPageAnalyzer,
  loadAnalyzerConfig
} from './book-processing/analyzer-config'
import { runAnalysisPhase } from './book-processing/page-analysis'
import { parsePageNav } from './playwright-utils'
import { assert, fileExists, getEnv } from './utils'

/**
 * Standalone "screenshot the Kindle web reader + analyze the pages" pipeline.
 *
 * This deliberately bypasses the broken metadata-endpoint scraping in
 * `extract-kindle-book.ts` (Amazon removed the `startReading`/`YJmetadata`
 * endpoints and the render-TAR body text is glyph-obfuscated). The only path to
 * readable text is OCR of the rendered page pixels, so we:
 *
 *   1. Reuse the SAME warm persistent browser profile the extractor already
 *      logged in with (`out/<ASIN>/data`), open the reader, and page through it.
 *   2. Screenshot the rendered reader image for each page to
 *      `out/<ASIN>/text-capture/page-####.png` (resumable, with end-of-book
 *      detection via consecutive-identical-screenshot hashing).
 *   3. Optionally (OCR=1) analyze each page PNG with a local multimodal CLI —
 *      the Codex CLI by default, or the Claude Code CLI with ANALYZER=claude —
 *      transcribing the text AND detecting every figure/chart/graph/diagram/
 *      formula/table/image — then assemble `out/<ASIN>/book-text.md`. Each
 *      visual is preserved as a cropped image under `text-capture/assets/`
 *      (falling back to the full page image) alongside the model's
 *      interpretation of what it shows, so nothing visual is lost.
 *
 *      The analysis phase lives in `book-processing/page-analysis.ts` and can be
 *      rerun on its own (including reprocessing pages that already have
 *      results) with `npx tsx src/analyze-book-text.ts`.
 *
 * Run with:  npx tsx src/capture-book-text.ts
 *   ASIN=<asin> MAX_PAGES=5                          -> capture only (5 pages, smoke test)
 *   ASIN=<asin> MAX_PAGES=100000 OCR=1               -> capture + analyze the whole book (codex)
 *   ASIN=<asin> MAX_PAGES=100000 OCR=1 ANALYZER=claude -> same, using the Claude Code CLI
 */

// The rendered current-page image inside the Kindle reader. Screenshotting this
// element captures the readable page PIXELS (not the obfuscated body text).
const krRendererMainImageSelector = '#kr-renderer .kg-full-page-img img'
const readerContainerSelector = '#kr-renderer'

// Stop once this many consecutive screenshots are byte-identical (end of book).
const identicalStopThreshold = 3

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function pad4(n: number): string {
  return `${n}`.padStart(4, '0')
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = getEnv(name)
  if (!raw || !raw.trim()) return fallback
  const value = Number.parseInt(raw.trim(), 10)
  assert(
    Number.isInteger(value) && value > 0,
    `${name} must be a positive integer, received "${raw}"`
  )
  return value
}

async function main(): Promise<void> {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required (set it in .env)')

  const amazonEmail = getEnv('AMAZON_EMAIL')
  const amazonPassword = getEnv('AMAZON_PASSWORD')

  const maxPages = parsePositiveIntEnv('MAX_PAGES', 5)
  const ocrEnabled = getEnv('OCR') === '1' || getEnv('OCR') === 'true'
  // Validate the analysis configuration (ANALYZER / REPROCESS / PAGES and the
  // CODEX_* / CLAUDE_* knobs) up front so a typo fails before the long browser
  // capture instead of after it.
  const analyzerConfig = ocrEnabled
    ? loadAnalyzerConfig(process.env)
    : undefined

  const outDir = path.join('out', asin)
  const userDataDir = path.join(outDir, 'data')
  const captureDir = path.join(outDir, 'text-capture')
  const captureStatePath = path.join(captureDir, 'capture-state.json')
  const bookTextPath = path.join(outDir, 'book-text.md')
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.mkdir(captureDir, { recursive: true })

  const bookReaderUrl = `https://read.amazon.com/?asin=${asin}`

  console.log(
    `[capture] ASIN=${asin} maxPages=${maxPages} ocr=${ocrEnabled}` +
      (analyzerConfig ? ` analyzer=${analyzerConfig.backend}` : '') +
      ` profile=${userDataDir}`
  )

  // --- Launch the reader with the SAME proven persistent-profile setup the
  // extractor uses, so the warm login is reused (no re-auth expected). ---
  const deviceScaleFactor = 2
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    args: [
      '--hide-crash-restore-bubble',
      '--disable-features=PasswordAutosave',
      '--disable-features=WebAuthn',
      '--disable-features=MacAppCodeSignClone'
    ],
    ignoreDefaultArgs: [
      '--enable-automation',
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled'
    ],
    bypassCSP: true,
    deviceScaleFactor,
    viewport: { width: 1280, height: 720 }
  })

  const page = context.pages()[0] ?? (await context.newPage())

  let capturedCount = 0

  async function writeCaptureState(): Promise<void> {
    await fs.writeFile(
      captureStatePath,
      JSON.stringify(
        {
          asin,
          capturedPages: capturedCount,
          updatedAt: new Date().toISOString()
        },
        null,
        2
      )
    )
  }

  async function getMainImageSrc(): Promise<string | undefined> {
    try {
      const src = await page
        .locator(krRendererMainImageSelector)
        .first()
        .getAttribute('src')
      return src ?? undefined
    } catch {
      return undefined
    }
  }

  async function getNavSuffix(): Promise<string> {
    try {
      const footerText = await page
        .locator('ion-footer ion-title')
        .first()
        .textContent()
      const nav = parsePageNav(footerText)
      if (nav?.page !== undefined) {
        return ` [reader page ${nav.page}/${nav.total}]`
      }
      if (nav?.location !== undefined) {
        return ` [location ${nav.location}/${nav.total}]`
      }
    } catch {}
    return ''
  }

  async function captureReaderScreenshot(): Promise<Buffer> {
    // Prefer the rendered page image element (cleanest crop for OCR), then the
    // reader container, then the full viewport as a last resort.
    for (const selector of [
      krRendererMainImageSelector,
      readerContainerSelector
    ]) {
      try {
        const locator = page.locator(selector).first()
        if ((await locator.count()) > 0) {
          return await locator.screenshot({ type: 'png', scale: 'css' })
        }
      } catch {}
    }
    return page.screenshot({ type: 'png', fullPage: false })
  }

  async function waitForPageChange(
    prevSrc: string | undefined,
    timeoutMs: number
  ): Promise<boolean> {
    await delay(300)
    // If we couldn't read a src to compare against, just settle on a fixed delay.
    if (prevSrc === undefined) {
      await delay(900)
      return true
    }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const src = await getMainImageSrc()
      if (src && src !== prevSrc) {
        await delay(250) // let the new render settle
        return true
      }
      await delay(100)
    }
    return false
  }

  // Dismiss any open Kindle reader overlay (settings/menu ion-popover or modal)
  // that would otherwise intercept page-turn clicks/keys. The reader leaves these
  // open when a menu-item selector we tried isn't found.
  async function dismissOverlays(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      const open = await page
        .locator('ion-popover[is-open="true"], ion-modal[is-open="true"]')
        .count()
        .catch(() => 0)
      if (!open) return
      try {
        await page.keyboard.press('Escape')
      } catch {}
      await delay(250)
    }
  }

  // Advance one page. Prefer the ArrowRight key; fall back to the reader's
  // next-page chevron. Returns whether the rendered page appears to have changed.
  async function advancePage(prevSrc: string | undefined): Promise<boolean> {
    // Ensure nothing (a lingering settings/menu popover) intercepts the advance.
    await dismissOverlays()
    try {
      await page.keyboard.press('ArrowRight')
    } catch {}
    if (await waitForPageChange(prevSrc, 4000)) return true

    try {
      await page
        .locator('.kr-chevron-container-right')
        .first()
        .click({ timeout: 4000 })
    } catch (err) {
      console.warn(
        '[capture] next-page chevron click failed:',
        (err as Error).message
      )
    }
    return waitForPageChange(prevSrc, 6000)
  }

  async function setSingleColumnLayout(): Promise<void> {
    try {
      const settingsButton = page
        .locator(
          'ion-button[aria-label="Reader settings"], ' +
            'button[aria-label="Reader settings"]'
        )
        .first()
      await settingsButton.waitFor({ timeout: 15_000 })
      await settingsButton.click()
      await delay(500)
      await page
        .locator('[role="radiogroup"][aria-label$=" columns"]', {
          hasText: 'Single Column'
        })
        .click({ timeout: 5000 })
      await delay(200)
      console.log('[capture] set single-column layout')
    } catch (err) {
      console.warn(
        '[capture] could not set single-column layout (continuing):',
        (err as Error).message
      )
    } finally {
      // Always close the settings popover so it can't intercept page turns.
      await dismissOverlays()
    }
  }

  // Best-effort: jump to the beginning of the book via the reader's
  // "Go to Page" modal (reusing the extractor's selectors). If this fails we
  // simply capture from the CURRENT reader position instead of hard-failing.
  async function goToStart(): Promise<boolean> {
    try {
      await page.locator('#reader-header').hover({ force: true })
      await delay(200)
      await page
        .locator('ion-button[aria-label="Reader menu"]')
        .click({ timeout: 5000 })
      await delay(500)
      await page
        .locator('ion-item[role="listitem"]', { hasText: 'Go to Page' })
        .click({ timeout: 5000 })
      await page.locator('ion-modal input[placeholder="page number"]').fill('1')
      await page
        .locator('ion-modal ion-button[item-i-d="go-to-modal-go-button"]')
        .click({ timeout: 5000 })
      await delay(800)

      const alertNo = page.locator('ion-alert button', { hasText: 'No' })
      if (await alertNo.isVisible().catch(() => false)) {
        await alertNo.click().catch(() => {})
      }
      console.log('[capture] navigated to start (page 1 via "Go to Page")')
      return true
    } catch (err) {
      console.warn(
        '[capture] could not go to start; capturing from CURRENT reader ' +
          'position (verify the first captured page):',
        (err as Error).message
      )
      return false
    } finally {
      // Whether or not "Go to Page" worked, close the menu/modal we opened so
      // a lingering ion-popover can't intercept subsequent page turns.
      await dismissOverlays()
    }
  }

  try {
    // Go directly to the reader if authenticated; otherwise wait for sign-in.
    await Promise.any([
      page.goto(bookReaderUrl, { timeout: 30_000 }),
      page.waitForURL('**/ap/signin', { timeout: 30_000 })
    ])

    if (/\/ap\/signin/.test(new URL(page.url()).pathname)) {
      console.warn('[capture] not authenticated — sign-in page detected')
      if (amazonEmail && amazonPassword) {
        console.log('[capture] attempting automated Amazon login...')
        await page.locator('input[type="email"]').fill(amazonEmail)
        await page.locator('input#continue').click()
        await page.locator('input[type="password"]').fill(amazonPassword)
        await page.locator('input#signInSubmit').click()

        if (!/\/kindle-library/.test(new URL(page.url()).pathname)) {
          const code = await input({
            message: '2-factor auth code? (leave blank if none)'
          })
          if (code) {
            await page.locator('input[type="tel"]').fill(code)
            await page
              .locator(
                'input[type="submit"][aria-labelledby="cvf-submit-otp-button-announce"]'
              )
              .click()
          }
        }
      } else {
        await input({
          message:
            'Please sign in to Amazon in the opened browser window, then ' +
            'press Enter to continue...'
        })
      }

      if (!page.url().includes('read.amazon.com')) {
        await page.goto(bookReaderUrl)
      }
    }

    console.log('[capture] waiting for reader to load...')
    await page
      .waitForSelector(krRendererMainImageSelector, { timeout: 60_000 })
      .catch(() => {
        console.warn(
          '[capture] main reader image did not appear within 60s; ' +
            'continuing anyway...'
        )
      })

    await setSingleColumnLayout()
    await goToStart()
    // Belt-and-suspenders: make sure no menu/settings overlay is left open
    // before we start turning pages.
    await dismissOverlays()

    // --- Capture loop --------------------------------------------------------
    console.log(`[capture] starting capture of up to ${maxPages} pages...`)
    let previousHash: string | undefined
    let consecutiveIdentical = 0

    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      const pngPath = path.join(captureDir, `page-${pad4(pageIndex)}.png`)
      const prevSrc = await getMainImageSrc()

      let buffer: Buffer
      let fromDisk = false
      if (await fileExists(pngPath)) {
        buffer = await fs.readFile(pngPath)
        fromDisk = true
        console.log(
          `[capture] page ${pageIndex}: already captured, skipping (resume)`
        )
      } else {
        buffer = await captureReaderScreenshot()
      }

      const hash = sha256(buffer)
      if (previousHash !== undefined && hash === previousHash) {
        consecutiveIdentical += 1
      } else {
        consecutiveIdentical = 1
      }
      previousHash = hash

      if (consecutiveIdentical >= identicalStopThreshold) {
        console.log(
          `[capture] ${identicalStopThreshold} identical screenshots in a ` +
            'row — assuming end of book, stopping.'
        )
        break
      }

      if (!fromDisk) {
        await fs.writeFile(pngPath, buffer)
        const navSuffix = await getNavSuffix()
        console.log(
          `[capture] page ${pageIndex}: captured ${buffer.length} bytes -> ` +
            `${pngPath}${navSuffix}`
        )
      }
      capturedCount = pageIndex
      await writeCaptureState()

      if (pageIndex >= maxPages) {
        console.log(
          `[capture] reached MAX_PAGES limit (${maxPages}), stopping.`
        )
        break
      }

      const changed = await advancePage(prevSrc)
      if (!changed) {
        console.log(
          `[capture] page did not change after advancing past page ` +
            `${pageIndex} — assuming end of book, stopping.`
        )
        break
      }
    }

    console.log(
      `[capture] capture complete: ${capturedCount} page(s) in ${captureDir}`
    )
  } finally {
    await context.close().catch(() => {})
    await context
      .browser()
      ?.close()
      .catch(() => {})
  }

  // --- Analysis phase (browser closed) --------------------------------------
  if (!analyzerConfig) {
    console.log(
      '[capture] OCR disabled — set OCR=1 to analyze the captured pages ' +
        '(or run `npx tsx src/analyze-book-text.ts` later). Capture-only complete.'
    )
    return
  }

  const analyzer = createPageAnalyzer(analyzerConfig, process.env)
  console.log(`[capture] preflight: checking the ${analyzer.backend} CLI...`)
  await analyzer.preflight()
  const summary = await runAnalysisPhase({
    captureDir,
    bookTextPath,
    analyzer,
    reprocess: analyzerConfig.reprocess,
    pages: analyzerConfig.pages
  })
  if (summary.failed > 0) {
    console.error(
      `[capture] ${summary.failed} page(s) failed analysis; rerun ` +
        '`npx tsx src/analyze-book-text.ts` to retry them without recapturing.'
    )
    process.exitCode = 1
  }
}

try {
  await main()
} catch (err) {
  console.error('[capture] fatal error:', err)
  process.exitCode = 1
}
