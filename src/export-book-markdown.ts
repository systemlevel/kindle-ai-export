import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookDocument } from './book-processing/types'
import type { BookMetadata } from './types'
import { renderBookMarkdown } from './book-processing/render-markdown'
import { assert, getEnv, readJsonFile } from './utils'

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)

  const document = await readJsonFile<BookDocument>(
    path.join(outDir, 'book-document.json')
  )
  const metadata = await readJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  assert(metadata.meta, 'invalid book metadata: missing meta')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  const allowPartial = getEnv('ALLOW_PARTIAL') === 'true'

  console.log(
    `[export-markdown] rendering ${asin} (${document.status}, ${document.counts.succeeded}/${document.counts.expected} pages succeeded)`
  )

  const output = renderBookMarkdown({ document, metadata, allowPartial })

  await fs.writeFile(path.join(outDir, 'book.md'), output)
  console.log(`[export-markdown] wrote ${path.join(outDir, 'book.md')}`)
  console.log(output)
}

await main()
