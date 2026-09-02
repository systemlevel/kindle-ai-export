import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { resolveBookDir } from '../../src/book-processing/book-dir'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

async function createOutRoot(
  books: Array<{ folder: string; asin?: string }>
): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'book-dir-'))
  temporaryDirectories.push(cwd)
  for (const book of books) {
    const captureDir = path.join(cwd, 'out', book.folder, 'text-capture')
    await fs.mkdir(captureDir, { recursive: true })
    if (book.asin) {
      await fs.writeFile(
        path.join(captureDir, 'capture-state.json'),
        JSON.stringify({ asin: book.asin, capturedPages: 1 })
      )
    }
  }
  return cwd
}

describe('resolveBookDir', () => {
  test('resolves a folder still named by its ASIN', async () => {
    const cwd = await createOutRoot([
      { folder: 'B000TEST01', asin: 'B000TEST01' }
    ])
    const resolved = await resolveBookDir(cwd, 'B000TEST01')
    expect(resolved).toEqual({
      outDir: path.join(cwd, 'out', 'B000TEST01'),
      folder: 'B000TEST01',
      asin: 'B000TEST01'
    })
  })

  test('resolves a folder by its title', async () => {
    const cwd = await createOutRoot([
      { folder: 'The Options Playbook', asin: 'B000TEST01' }
    ])
    const resolved = await resolveBookDir(cwd, 'The Options Playbook')
    expect(resolved).toEqual({
      outDir: path.join(cwd, 'out', 'The Options Playbook'),
      folder: 'The Options Playbook',
      asin: 'B000TEST01'
    })
  })

  test('resolves an ASIN to a folder renamed to the title', async () => {
    const cwd = await createOutRoot([
      { folder: 'Another Book', asin: 'B000OTHER0' },
      { folder: 'The Options Playbook', asin: 'B000TEST01' }
    ])
    const resolved = await resolveBookDir(cwd, 'b000test01')
    expect(resolved.folder).toBe('The Options Playbook')
    expect(resolved.asin).toBe('B000TEST01')
  })

  test('matches the title case-insensitively', async () => {
    const cwd = await createOutRoot([
      { folder: 'The Options Playbook', asin: 'B000TEST01' }
    ])
    const resolved = await resolveBookDir(cwd, 'the options playbook')
    expect(resolved.folder).toBe('The Options Playbook')
  })

  test('falls back to the folder name as ASIN when no capture state exists', async () => {
    const cwd = await createOutRoot([{ folder: 'B000TEST01' }])
    const resolved = await resolveBookDir(cwd, 'B000TEST01')
    expect(resolved.asin).toBe('B000TEST01')
  })

  test('lists the available books when nothing matches', async () => {
    const cwd = await createOutRoot([
      { folder: 'The Options Playbook', asin: 'B000TEST01' },
      { folder: 'B000OTHER0', asin: 'B000OTHER0' }
    ])
    await expect(resolveBookDir(cwd, 'Missing Book')).rejects.toThrow(
      /Missing Book.*Available books: B000OTHER0, The Options Playbook \(B000TEST01\)/
    )
  })

  test('rejects references that escape the out directory', async () => {
    const cwd = await createOutRoot([])
    await expect(resolveBookDir(cwd, '../secrets')).rejects.toThrow(/inside/)
  })

  test('rejects an empty reference', async () => {
    const cwd = await createOutRoot([])
    await expect(resolveBookDir(cwd, '   ')).rejects.toThrow(/empty/)
  })
})
