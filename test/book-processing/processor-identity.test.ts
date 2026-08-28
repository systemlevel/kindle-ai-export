import { createHash } from 'node:crypto'

import { describe, expect, test } from 'vitest'

import type { AvailablePageSource } from '../../src/book-processing/types'
import {
  createPageCacheKey,
  createProcessorIdentity
} from '../../src/book-processing/processor-identity'

const input = {
  codexCliVersion: '0.1.0',
  requestedModel: null,
  promptVersion: '1',
  prompt: 'Observe the page.',
  outputSchemaVersion: '1',
  outputSchema: { type: 'object', properties: { pages: { type: 'array' } } },
  normalizerVersion: '1'
}

const source: AvailablePageSource = {
  captureId: 'c000000',
  index: 0,
  printedPage: 1,
  position: null,
  screenshotPath: 'pages/0000-0001.png',
  rendererBatch: null,
  availability: 'available',
  screenshotSha256: 'a'.repeat(64),
  width: 20,
  height: 10
}

describe('createProcessorIdentity', () => {
  test('hashes complete prompt and schema contents deterministically', () => {
    const first = createProcessorIdentity(input)
    const reorderedSchema = createProcessorIdentity({
      ...input,
      outputSchema: { properties: { pages: { type: 'array' } }, type: 'object' }
    })

    expect(first).toMatchObject({
      runnerKind: 'codex-cli',
      requestedModel: 'cli-default',
      promptVersion: '1',
      outputSchemaVersion: '1',
      normalizerVersion: '1'
    })
    expect(first.promptSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(first.outputSchemaSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(first.configurationHash).toMatch(/^[a-f0-9]{64}$/)
    expect(reorderedSchema).toEqual(first)
  })

  test('changes cache key when any processor or source input changes', () => {
    const processor = createProcessorIdentity(input)
    const first = createPageCacheKey(source, processor)

    expect(
      createPageCacheKey(source, { ...processor, promptVersion: '2' })
    ).not.toBe(first)
    expect(
      createPageCacheKey(
        { ...source, screenshotSha256: 'b'.repeat(64) },
        processor
      )
    ).not.toBe(first)
    expect(
      createPageCacheKey(
        source,
        createProcessorIdentity({ ...input, prompt: 'Observe all text.' })
      )
    ).not.toBe(first)
    expect(
      createPageCacheKey(
        source,
        createProcessorIdentity({
          ...input,
          outputSchema: { type: 'object', required: ['pages'] }
        })
      )
    ).not.toBe(first)
  })

  test('sorts schema keys by code unit rather than host locale', () => {
    const processor = createProcessorIdentity({
      ...input,
      outputSchema: { ä: 'umlaut', z: 'zee' }
    })
    const expectedCanonicalSchema = '{"z":"zee","ä":"umlaut"}'

    expect(processor.outputSchemaSha256).toBe(
      createHash('sha256').update(expectedCanonicalSchema).digest('hex')
    )
  })
})
