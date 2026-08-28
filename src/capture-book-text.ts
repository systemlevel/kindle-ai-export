import 'dotenv/config'

import type { Readable } from 'node:stream'
import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { input } from '@inquirer/prompts'
import delay from 'delay'
import { chromium } from 'patchright'

import { parsePageNav } from './playwright-utils'
import { assert, fileExists, getEnv } from './utils'

/**
 * Standalone "screenshot the Kindle web reader + Codex-OCR the pages" pipeline.
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
 *   3. Optionally (OCR=1) transcribe each page PNG with the local `codex` CLI
 *      and concatenate the results into `out/<ASIN>/book-text.md`.
 *
 * Run with:  npx tsx src/capture-book-text.ts
 *   ASIN=<asin> MAX_PAGES=5            -> capture only (5 pages, smoke test)
 *   ASIN=<asin> MAX_PAGES=100000 OCR=1 -> capture + OCR the whole book
 */

// The rendered current-page image inside the Kindle reader. Screenshotting this
// element captures the readable page PIXELS (not the obfuscated body text).
const krRendererMainImageSelector = '#kr-renderer .kg-full-page-img img'
const readerContainerSelector = '#kr-renderer'

// Stop once this many consecutive screenshots are byte-identical (end of book).
const identicalStopThreshold = 3

// Verbatim-transcription prompt. We intentionally do NOT use the strict JSON
// output schema here — a plain transcription written to --output-last-message
// is read back directly as the page's text.
const ocrPrompt =
  'Transcribe every word of readable text on this book page image, verbatim ' +
  'and in natural reading order. Output ONLY the transcribed text with ' +
  'paragraph breaks preserved — no commentary, headers, or markup.'

type SpawnedCodex = ChildProcessByStdio<null, Readable, Readable>

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
  const codexBin = getEnv('CODEX_BIN') || 'codex'
  const codexModel = getEnv('CODEX_MODEL') || undefined
  const codexTimeoutMs = parsePositiveIntEnv('CODEX_TIMEOUT_MS', 300_000)

  const outDir = path.join('out', asin)
  const userDataDir = path.join(outDir, 'data')
  const captureDir = path.join(outDir, 'text-capture')
  const captureStatePath = path.join(captureDir, 'capture-state.json')
  const bookTextPath = path.join(outDir, 'book-text.md')
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.mkdir(captureDir, { recursive: true })

  const bookReaderUrl = `https://read.amazon.com/?asin=${asin}`

  console.log(
    `[capture] ASIN=${asin} maxPages=${maxPages} ocr=${ocrEnabled} profile=${userDataDir}`
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

  // Advance one page. Prefer the ArrowRight key; fall back to the reader's
  // next-page chevron. Returns whether the rendered page appears to have changed.
  async function advancePage(prevSrc: string | undefined): Promise<boolean> {
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
      await settingsButton.click() // close
      await delay(500)
      console.log('[capture] set single-column layout')
    } catch (err) {
      console.warn(
        '[capture] could not set single-column layout (continuing):',
        (err as Error).message
      )
      try {
        await page.keyboard.press('Escape')
      } catch {}
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

  // --- OCR phase (browser closed) -------------------------------------------
  if (!ocrEnabled) {
    console.log(
      '[capture] OCR disabled — set OCR=1 to transcribe the captured pages. ' +
        'Capture-only complete.'
    )
    return
  }

  await runOcrPhase({
    captureDir,
    bookTextPath,
    codexBin,
    codexModel,
    codexTimeoutMs
  })
}

interface OcrPhaseOptions {
  captureDir: string
  bookTextPath: string
  codexBin: string
  codexModel: string | undefined
  codexTimeoutMs: number
}

async function runOcrPhase(options: OcrPhaseOptions): Promise<void> {
  const { captureDir, bookTextPath, codexBin, codexModel, codexTimeoutMs } =
    options

  const pngFiles = (await fs.readdir(captureDir))
    .filter((f) => /^page-\d+\.png$/.test(f))
    .toSorted()
  console.log(`[ocr] found ${pngFiles.length} captured page image(s)`)

  let transcribed = 0
  let skipped = 0
  let failed = 0

  for (const file of pngFiles) {
    const pngPath = path.join(captureDir, file)
    const txtPath = pngPath.replace(/\.png$/, '.txt')

    if (await fileExists(txtPath)) {
      skipped += 1
      console.log(`[ocr] ${file}: already transcribed, skipping (resume)`)
      continue
    }

    console.log(`[ocr] ${file}: transcribing with codex...`)
    try {
      const text = await ocrPageWithCodex(pngPath, {
        codexBin,
        codexModel,
        codexTimeoutMs
      })
      await fs.writeFile(txtPath, `${text}\n`)
      transcribed += 1
      console.log(
        `[ocr] ${file}: transcribed ${text.length} chars -> ` +
          path.basename(txtPath)
      )
    } catch (err) {
      failed += 1
      console.error(`[ocr] ${file}: FAILED — ${(err as Error).message}`)
    }
  }

  // Concatenate every transcribed page (in order) into a single markdown file.
  const txtFiles = (await fs.readdir(captureDir))
    .filter((f) => /^page-\d+\.txt$/.test(f))
    .toSorted()
  const parts: string[] = []
  for (const file of txtFiles) {
    const text = (await fs.readFile(path.join(captureDir, file), 'utf8')).trim()
    parts.push(text)
  }
  const combined = `${parts.join('\n\n---\n\n')}\n`
  await fs.writeFile(bookTextPath, combined)

  console.log(
    `[ocr] done: ${transcribed} transcribed, ${skipped} skipped, ${failed} failed`
  )
  console.log(
    `[ocr] wrote ${bookTextPath} — ${txtFiles.length} page(s), ` +
      `${combined.length} characters`
  )
}

interface CodexOcrOptions {
  codexBin: string
  codexModel: string | undefined
  codexTimeoutMs: number
}

/**
 * OCR a single page PNG via the local `codex` CLI, using the verified
 * invocation (stdin closed; final transcription written to
 * `--output-last-message`). Returns the transcribed text.
 */
async function ocrPageWithCodex(
  pngPath: string,
  options: CodexOcrOptions
): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-ocr-'))
  const resultPath = path.join(tmpDir, 'result.txt')
  const absImage = path.resolve(pngPath)

  try {
    await spawnCodex(absImage, tmpDir, resultPath, options)

    // Bound the untrusted result file before reading it into memory.
    const stats = await fs.stat(resultPath).catch(() => undefined)
    if (!stats) throw new Error('codex did not write an output file')
    const maxResultBytes = 8 * 1024 * 1024
    if (stats.size > maxResultBytes) {
      throw new Error(`codex output file too large (${stats.size} bytes)`)
    }
    if (stats.size === 0) throw new Error('codex produced an empty output file')

    const text = (await fs.readFile(resultPath, 'utf8')).trim()
    if (!text) throw new Error('codex output was blank after trimming')
    return text
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

function spawnCodex(
  imagePath: string,
  cwd: string,
  resultPath: string,
  options: CodexOcrOptions
): Promise<void> {
  const args = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--cd',
    cwd,
    '--image',
    imagePath,
    '--output-last-message',
    resultPath,
    '--json'
  ]
  if (options.codexModel) args.push('--model', options.codexModel)
  args.push(ocrPrompt)

  return new Promise<void>((resolve, reject) => {
    let child: SpawnedCodex
    try {
      // stdin ignored (closed) per the verified invocation; env is inherited.
      child = spawn(options.codexBin, args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      reject(err as Error)
      return
    }

    let settled = false
    let turnCompleted = false
    let pending = ''
    let stderrSample = ''

    const timeout = setTimeout(() => {
      if (settled) return
      try {
        child.kill('SIGKILL')
      } catch {}
      settle(new Error(`codex timed out after ${options.codexTimeoutMs}ms`))
    }, options.codexTimeoutMs)

    function settle(err?: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (err) reject(err)
      else resolve()
    }

    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as { type?: string }
          if (event.type === 'turn.completed') turnCompleted = true
        } catch {}
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrSample.length < 4096) {
        stderrSample += chunk
          .toString('utf8')
          .slice(0, 4096 - stderrSample.length)
      }
    })

    child.once('error', (err) => settle(err))
    child.once('close', (code) => {
      if (code === 0) {
        if (!turnCompleted) {
          console.warn(
            '[ocr] codex exited 0 but no turn.completed event was seen; ' +
              'relying on the output file'
          )
        }
        settle()
      } else {
        settle(
          new Error(
            `codex exited with code ${code}` +
              (stderrSample ? `: ${stderrSample.trim()}` : '')
          )
        )
      }
    })
  })
}

try {
  await main()
} catch (err) {
  console.error('[capture] fatal error:', err)
  process.exitCode = 1
}
