import { describe, expect, test } from 'vitest'

import { validateRawCodexBatch } from '../../src/book-processing/validate-codex-output'

const valid = {
  schemaVersion: '1',
  pages: [
    {
      pageId: 'c000000',
      warnings: [],
      blocks: [
        {
          order: 0,
          kind: 'heading',
          runs: [{ text: 'Chapter One', styles: ['bold'] }],
          alignment: 'center',
          indentLevel: 0,
          headingLevel: 1,
          region: { x: 100, y: 100, width: 800, height: 100 },
          regionConfidence: 'high',
          mediaDescription: null,
          caption: null
        }
      ]
    }
  ]
}

describe('validateRawCodexBatch', () => {
  test('accepts the strict schema and requested order', () => {
    expect(validateRawCodexBatch(valid, ['c000000'])).toEqual(valid)
  })

  test('rejects a successful-looking response with the wrong page identity', () => {
    expect(() => validateRawCodexBatch(valid, ['c000001'])).toThrow(
      'Codex returned page IDs [c000000]; expected [c000001]'
    )
  })

  test('rejects duplicate page IDs', () => {
    const input = structuredClone(valid)
    input.pages.push(structuredClone(input.pages[0]!))

    expect(() => validateRawCodexBatch(input, ['c000000', 'c000001'])).toThrow(
      'Codex returned duplicate page IDs'
    )
  })

  test('rejects noncontiguous block order', () => {
    const input = structuredClone(valid)
    input.pages[0]!.blocks[0]!.order = 2

    expect(() => validateRawCodexBatch(input, ['c000000'])).toThrow(
      'Page c000000 block order must be contiguous from zero'
    )
  })

  test('rejects heading levels on non-heading blocks', () => {
    const input = structuredClone(valid)
    input.pages[0]!.blocks[0]!.kind = 'paragraph'

    expect(() => validateRawCodexBatch(input, ['c000000'])).toThrow(
      'Page c000000 block 0 may only have a heading level when kind is heading'
    )
  })

  test('rejects regions extending beyond normalized page bounds', () => {
    const input = structuredClone(valid)
    input.pages[0]!.blocks[0]!.region = {
      x: 900,
      y: 0,
      width: 101,
      height: 100
    }

    expect(() => validateRawCodexBatch(input, ['c000000'])).toThrow(
      'Page c000000 block 0 region must not exceed normalized page bounds'
    )
  })
})
