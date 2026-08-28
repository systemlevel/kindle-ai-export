import { describe, expect, test } from 'vitest'

import type {
  AvailablePageSource,
  ProcessorIdentity,
  RawCodexBlock
} from '../../src/book-processing/types'
import {
  createBlockId,
  createCitation,
  createEditionHash
} from '../../src/book-processing/citation'

const asin = 'TESTASIN'
const editionVersion = 'edition-1'

const source: AvailablePageSource = {
  captureId: 'c000000',
  index: 0,
  printedPage: 1,
  position: null,
  screenshotPath: 'pages/0000-0001.png',
  rendererBatch: null,
  availability: 'available',
  screenshotSha256: 'a'.repeat(64),
  width: 100,
  height: 50
}

const processor: ProcessorIdentity = {
  runnerKind: 'codex-cli',
  codexCliVersion: '0.1.0',
  requestedModel: 'cli-default',
  promptVersion: '1',
  promptSha256: 'b'.repeat(64),
  outputSchemaVersion: '1',
  outputSchemaSha256: 'c'.repeat(64),
  normalizerVersion: '1',
  configurationHash: 'd'.repeat(64)
}

const block: RawCodexBlock = {
  order: 0,
  kind: 'paragraph',
  runs: [{ text: 'Hello world', styles: [] }],
  alignment: 'left',
  indentLevel: 0,
  headingLevel: null,
  region: null,
  regionConfidence: 'unknown',
  mediaDescription: null,
  caption: null
}

describe('createBlockId', () => {
  test('zero-pads the order to a 4-digit b-prefixed id', () => {
    expect(createBlockId(0)).toBe('b0000')
    expect(createBlockId(12)).toBe('b0012')
  })
})

describe('createEditionHash', () => {
  test('is deterministic for the same asin and edition version', () => {
    const first = createEditionHash(asin, editionVersion)
    const second = createEditionHash(asin, editionVersion)

    expect(first).toBe(second)
  })

  test('changes when the edition version changes', () => {
    const first = createEditionHash(asin, editionVersion)
    const second = createEditionHash(asin, 'edition-2')

    expect(second).not.toBe(first)
  })
})

describe('createCitation', () => {
  const editionHash = createEditionHash(asin, editionVersion)

  test('produces the documented knd:<asin>:<edition12>:<source12>:<processor12>:b<NNNN> id shape', () => {
    const citation = createCitation({
      asin,
      editionVersion,
      editionHash,
      source,
      processor,
      block
    })

    expect(citation.id).toBe(
      [
        'knd',
        asin,
        editionHash.slice(0, 12),
        source.screenshotSha256.slice(0, 12),
        processor.configurationHash.slice(0, 12),
        'b0000'
      ].join(':')
    )
    expect(citation.id).toMatch(
      /^knd:TESTASIN:[a-f0-9]{12}:[a-f0-9]{12}:[a-f0-9]{12}:b0000$/
    )
  })

  test('is deterministic: identical inputs produce a byte-identical id', () => {
    const first = createCitation({
      asin,
      editionVersion,
      editionHash,
      source,
      processor,
      block
    })
    const second = createCitation({
      asin,
      editionVersion,
      editionHash,
      source,
      processor,
      block
    })

    expect(second.id).toBe(first.id)
  })

  test('changes the id when the screenshot sha changes', () => {
    const first = createCitation({
      asin,
      editionVersion,
      editionHash,
      source,
      processor,
      block
    })
    const second = createCitation({
      asin,
      editionVersion,
      editionHash,
      source: { ...source, screenshotSha256: 'e'.repeat(64) },
      processor,
      block
    })

    expect(second.id).not.toBe(first.id)
  })

  test('changes the id when the processor configuration hash changes', () => {
    const first = createCitation({
      asin,
      editionVersion,
      editionHash,
      source,
      processor,
      block
    })
    const second = createCitation({
      asin,
      editionVersion,
      editionHash,
      source,
      processor: { ...processor, configurationHash: 'f'.repeat(64) },
      block
    })

    expect(second.id).not.toBe(first.id)
  })
})
