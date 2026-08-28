/* eslint-disable no-process-env */

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  promises as fs,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type {
  BookDocument,
  BookPageRecord,
  NormalizedBlock
} from '../../src/book-processing/types'
import type { BookMetadata } from '../../src/types'
import {
  processBook,
  type ProcessBookOptions
} from '../../src/transcribe-book-content'

/**
 * Opt-in acceptance test that drives the production `processBook` pipeline
 * against the REAL, locally authenticated `codex` CLI. It is skipped by
 * default (and therefore launches no `codex` process) because it costs real
 * Codex usage and requires `codex login` to already be configured on the
 * machine running it. Enable it explicitly with:
 *
 *   RUN_CODEX_INTEGRATION=1 pnpm exec vitest run test/integration/codex-cli.test.ts
 */
const runRealCodex = process.env.RUN_CODEX_INTEGRATION === '1'

const sampleAsin = 'B0819W19WD'
const samplesDir = path.resolve('examples', sampleAsin)
const samplePagesDir = path.join(samplesDir, 'pages')
const samplePageOneFileName = '0000-0001.png'
const samplePageTwoFileName = '0001-0001.png'

/** Collapses all whitespace (including the paragraph-boundary newlines the
 * normalizer inserts between blocks) to single spaces so comparisons are
 * insensitive to exactly how text is joined, matching how the repository's
 * pre-Codex reference transcription was validated. */
function normalizedWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim()
}

/** Distinctive, verbatim phrases from the committed reference transcription
 * (`examples/B0819W19WD/content.json`). Page 1 is the opening of Alastair
 * Reynolds' "Revelation Space"; these proper nouns and coined terms are
 * reproduced character-for-character by any faithful transcription of the
 * same image, so their presence proves genuine reading without demanding the
 * byte-exact whole-page equality two different models never share. */
const pageOnePhrases = [
  'Mantell Sector',
  'Delta Pavonis',
  'razorstorm',
  'Sylveste'
]
const pageTwoPhrases = ['Ptero Steppes', 'evacuation order', 'dust devils']

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

function sampleMetadata(): BookMetadata {
  return {
    meta: {
      ACR: 'acr',
      asin: sampleAsin,
      authorList: ['Alastair Reynolds'],
      bookSize: '1',
      bookType: 'ebook',
      cover: 'cover.jpg',
      language: 'en',
      positions: { cover: 0, srl: 0, toc: 0 },
      publisher: 'Orbit',
      refEmId: 'ref',
      releaseDate: '2020-04-21',
      sample: false,
      title: 'Revelation Space (The Inhibitor Trilogy)',
      version: 'edition-1',
      startPosition: 0,
      endPosition: 1000
    },
    info: {
      clippingLimit: 0,
      contentChecksum: null,
      contentType: 'ebook',
      contentVersion: '1',
      deliveredAsin: sampleAsin,
      downloadRestrictionReason: null,
      expirationDate: null,
      format: 'kfx',
      formatVersion: '1',
      fragmentMapUrl: null,
      hasAnnotations: false,
      isOwned: true,
      isSample: false,
      kindleSessionId: 'session',
      lastPageReadData: { deviceName: 'device', position: 0, syncTime: 0 },
      manifestUrl: null,
      originType: 'purchase',
      pageNumberUrl: null,
      requestedAsin: sampleAsin,
      srl: 0
    },
    nav: {
      startPosition: 0,
      endPosition: 1000,
      startContentPosition: 0,
      startContentPage: 1,
      endContentPosition: 1000,
      endContentPage: 2,
      totalNumPages: 2,
      totalNumContentPages: 2
    },
    toc: [{ label: 'Chapter 1', positionId: 0, page: 1, depth: 0 }],
    pages: [
      { index: 0, page: 1, screenshot: `pages/${samplePageOneFileName}` },
      { index: 1, page: 1, screenshot: `pages/${samplePageTwoFileName}` }
    ],
    locationMap: { locations: [], navigationUnit: [] }
  }
}

/** Builds a fresh temporary `out/<ASIN>` directory containing copies of the
 * repository's two existing public sample page PNGs plus compatible
 * synthetic metadata, and returns options that point the production
 * `processBook` pipeline at it using the real, PATH-resolved `codex` binary
 * (never a test fake). */
function realCodexFixtureOptions(): ProcessBookOptions {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'kindle-codex-integration-'))
  temporaryDirectories.push(cwd)

  const outDir = path.join(cwd, 'out', sampleAsin)
  mkdirSync(path.join(outDir, 'pages'), { recursive: true })
  copyFileSync(
    path.join(samplePagesDir, samplePageOneFileName),
    path.join(outDir, 'pages', samplePageOneFileName)
  )
  copyFileSync(
    path.join(samplePagesDir, samplePageTwoFileName),
    path.join(outDir, 'pages', samplePageTwoFileName)
  )
  writeFileSync(
    path.join(outDir, 'metadata.json'),
    JSON.stringify(sampleMetadata())
  )

  const env: NodeJS.ProcessEnv = { ...process.env, ASIN: sampleAsin }
  // Always exercise the real, PATH-resolved `codex` binary here, regardless
  // of any `CODEX_BIN` fake left over in the ambient environment by other
  // tests or tooling.
  delete env.CODEX_BIN

  return { cwd, env }
}

function normalizedText(page: BookPageRecord): string {
  if (page.status !== 'succeeded') {
    throw new Error(
      `Expected a succeeded page checkpoint, got status "${page.status}"`
    )
  }

  const text = page.document.blocks
    .filter((block) => block.kind !== 'page-number')
    .map((block) => block.text)
    .join('\n')

  return normalizedWhitespace(text)
}

function allSuccessfulBlocks(document: BookDocument): NormalizedBlock[] {
  return document.pages.flatMap((page) =>
    page.status === 'succeeded' ? page.document.blocks : []
  )
}

describe.skipIf(!runRealCodex)('real Codex CLI integration', () => {
  test('processes the two public sample images as one validated batch', async () => {
    const result = await processBook(realCodexFixtureOptions())

    expect(result.document.status).toBe('complete')
    expect(result.document.pages.map((page) => page.source.captureId)).toEqual([
      'c000000',
      'c000001'
    ])
    const pageOneText = normalizedText(result.document.pages[0]!)
    const pageTwoText = normalizedText(result.document.pages[1]!)

    // A faithful transcription of the opening page is a full page of prose,
    // not a stub — guards against a "successful" but near-empty transcription.
    expect(pageOneText.length).toBeGreaterThan(400)

    // Prove genuine, cross-model transcription via distinctive verbatim phrases
    // rather than byte-exact equality (two different LLMs never match exactly).
    for (const phrase of pageOnePhrases) {
      expect(pageOneText.toLowerCase()).toContain(phrase.toLowerCase())
    }
    for (const phrase of pageTwoPhrases) {
      expect(pageTwoText.toLowerCase()).toContain(phrase.toLowerCase())
    }

    expect(
      allSuccessfulBlocks(result.document).every((block) =>
        block.citation.id.startsWith('knd:')
      )
    ).toBe(true)
  }, 360_000)
})
