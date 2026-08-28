/* eslint-disable no-process-env */
import 'dotenv/config'

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type {
  AvailablePageSource,
  BookDocument,
  PageSource
} from './book-processing/types'
import type { BookMetadata } from './types'
import {
  assembleBookDocument,
  writeBookDocument
} from './book-processing/assemble-book'
import {
  type ProcessingRunResult,
  processPageSources,
  type SchedulerRunBatch
} from './book-processing/batch-scheduler'
import { createCheckpointStore } from './book-processing/checkpoint-store'
import {
  type CodexBatchInput,
  type CodexInstallation,
  inspectCodexInstallation,
  runCodexBatch
} from './book-processing/codex-runner'
import {
  partialLegacyContentRejectionMessage,
  projectLegacyContent,
  writeLegacyContent
} from './book-processing/legacy-content'
import { normalizePage } from './book-processing/normalize-page'
import { buildPageSources } from './book-processing/page-source'
import {
  loadProcessingConfig,
  type ProcessingConfig
} from './book-processing/processing-config'
import { createProcessingStateStore } from './book-processing/processing-state'
import { createProcessorIdentity } from './book-processing/processor-identity'
import { assert, readJsonFile } from './utils'

/** Version tags baked into the processor identity / cache key. Bump these
 * whenever the checked-in prompt, output schema, or normalizer semantics
 * change so previously cached page checkpoints are correctly invalidated. */
const promptVersion = '1'
const outputSchemaVersion = '1'
const normalizerVersion = '1'

const bookProcessingDir = fileURLToPath(
  new URL('book-processing/', import.meta.url)
)
const promptPath = path.join(bookProcessingDir, 'codex-page-prompt.md')
const outputSchemaPath = path.join(
  bookProcessingDir,
  'codex-output.schema.json'
)

export interface ProcessBookOptions {
  /** Root directory that contains `out/<ASIN>/`. Defaults to `process.cwd()`. */
  cwd?: string
  /** Environment the run reads its configuration and credentials from. */
  env: NodeJS.ProcessEnv
  /** Cancels the run cooperatively while preserving completed checkpoints. */
  signal?: AbortSignal
}

export interface ProcessBookResult {
  document: BookDocument
  run: ProcessingRunResult
}

/**
 * Drives one book through the local Codex CLI pipeline end to end: load the
 * book metadata, build ordered page sources, preflight the Codex CLI, derive a
 * deterministic processor identity, run the resumable batch scheduler against
 * the real sandboxed Codex runner, and assemble the canonical + legacy outputs.
 *
 * The scheduler is fed production dependencies here (the real Codex runner
 * adapter, page normalizer, atomic checkpoint/state stores, and timers); the
 * same function is unit-tested by injecting a fake `codex` binary through
 * `env.CODEX_BIN`, so no OpenAI credentials or network access are ever needed.
 */
export async function processBook(
  options: ProcessBookOptions
): Promise<ProcessBookResult> {
  const { env } = options
  const cwd = options.cwd ?? process.cwd()

  const config = loadProcessingConfig(env)

  const asin = env.ASIN
  assert(asin, 'ASIN is required')

  const outDir = path.join(cwd, 'out', asin)
  const metadata = await readJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  assert(metadata.pages?.length, 'no page screenshots found')

  const sources = await buildPageSources(metadata, outDir)
  const availableById = availableSourcesById(sources)
  console.log(
    `[transcribe] loaded ${sources.length} page sources (${availableById.size} available) for ${asin}`
  )

  // Preflight: `codex --version` + `codex login status`. A configuration
  // failure here means we cannot even identify the processor, so abort before
  // touching any pages.
  const installation = await inspectCodexInstallation(config.codexBin, env)
  if (!installation.ok) {
    console.error(
      `[transcribe] Codex preflight failed (${installation.failure.code}): ${installation.failure.message}`
    )
    throw new Error(
      `Codex preflight failed (${installation.failure.code}): ${installation.failure.message}`
    )
  }
  const codex: CodexInstallation = installation.installation
  console.log('[transcribe] Codex preflight ok', {
    cliVersion: codex.cliVersion,
    authentication: codex.authentication
  })

  const prompt = await fs.readFile(promptPath, 'utf8')
  const outputSchema = JSON.parse(
    await fs.readFile(outputSchemaPath, 'utf8')
  ) as unknown

  const processor = createProcessorIdentity({
    codexCliVersion: codex.cliVersion,
    requestedModel: config.requestedModel,
    promptVersion,
    prompt,
    outputSchemaVersion,
    outputSchema,
    normalizerVersion
  })

  const runId = createRunId()
  const store = await createCheckpointStore(outDir)
  const stateStore = await createProcessingStateStore(outDir)

  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kindle-codex-')
  )
  let run: ProcessingRunResult
  try {
    const runBatch = createCodexRunBatch({
      runId,
      config,
      env,
      prompt,
      outDir,
      temporaryRoot,
      availableById
    })

    console.log('[transcribe] processing run started', {
      runId,
      pages: sources.length
    })
    run = await processPageSources({
      runId,
      sources,
      processor,
      asin: metadata.meta.asin,
      editionVersion: metadata.meta.version,
      outDir,
      config,
      store,
      stateStore,
      runBatch,
      normalizePage,
      signal: options.signal
    })
  } finally {
    await fs
      .rm(temporaryRoot, { recursive: true, force: true })
      .catch(() => undefined)
  }

  console.log('[transcribe] processing run finished', {
    runId,
    status: run.status,
    counts: run.counts
  })

  // `document.status` is derived from final counts and can legitimately
  // differ from `run.status` (e.g. a whole-run failure that still produced
  // some successful pages assembles as `partial`).
  const document = assembleBookDocument({
    metadata,
    sources,
    checkpoints: run.records,
    runStatus: run.status,
    processor
  })
  await writeBookDocument(outDir, document)

  // Legacy projection refuses a non-complete document unless ALLOW_PARTIAL is
  // set; write it only when it will succeed so the canonical document is always
  // persisted regardless of outcome.
  if (document.status === 'complete' || config.allowPartial) {
    await writeLegacyContent(
      outDir,
      projectLegacyContent(document, metadata.toc ?? [], {
        allowPartial: config.allowPartial
      })
    )
  } else {
    console.warn(`[transcribe] ${partialLegacyContentRejectionMessage}`)
  }

  return { document, run }
}

interface CodexRunBatchDeps {
  runId: string
  config: ProcessingConfig
  env: NodeJS.ProcessEnv
  prompt: string
  outDir: string
  temporaryRoot: string
  availableById: Map<string, AvailablePageSource>
}

/**
 * Production adapter mapping the scheduler's injectable `runBatch` boundary
 * onto the real sandboxed {@link runCodexBatch}. For each batch it resolves
 * absolute image paths from the page sources, appends the requested page IDs to
 * the versioned prompt (kept out of the checked-in prompt file), and forwards
 * the run's timeouts, diagnostic limits, and cancellation signal. A
 * `CodexRunResult` is structurally assignable to the scheduler's
 * `SchedulerBatchResult`, so it is returned directly.
 */
function createCodexRunBatch(deps: CodexRunBatchDeps): SchedulerRunBatch {
  return async (pageIds, context) => {
    const imagePaths = pageIds.map((pageId) => {
      const source = deps.availableById.get(pageId)
      if (!source) {
        throw new Error(
          `Scheduler requested an unavailable page source: ${pageId}`
        )
      }
      return path.resolve(deps.outDir, source.screenshotPath)
    })

    const input: CodexBatchInput = {
      runId: deps.runId,
      batchId: context.batchId,
      temporaryRoot: deps.temporaryRoot,
      pageIds,
      imagePaths,
      outputSchemaPath,
      prompt: `${deps.prompt}\nRequested page IDs in attachment order: ${pageIds.join(', ')}`,
      model: deps.config.requestedModel ?? undefined
    }

    return runCodexBatch(input, {
      codexBin: deps.config.codexBin,
      env: deps.env,
      timeoutMs: deps.config.timeoutMs,
      terminationGraceMs: deps.config.terminationGraceMs,
      stdoutMaxBytes: deps.config.stdoutLimitBytes,
      stderrMaxBytes: deps.config.stderrLimitBytes,
      signal: context.signal
    })
  }
}

function availableSourcesById(
  sources: PageSource[]
): Map<string, AvailablePageSource> {
  const byId = new Map<string, AvailablePageSource>()
  for (const source of sources) {
    if (source.availability === 'available') {
      byId.set(source.captureId, source)
    }
  }
  return byId
}

function createRunId(): string {
  return `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
}

async function main(): Promise<void> {
  const controller = new AbortController()
  const onSignal = (signal: NodeJS.Signals) => {
    console.warn(`[transcribe] received ${signal}, cancelling run...`)
    controller.abort()
  }
  const onSigint = () => onSignal('SIGINT')
  const onSigterm = () => onSignal('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)

  try {
    const { run, document } = await processBook({
      cwd: process.cwd(),
      env: process.env,
      signal: controller.signal
    })
    console.log('[transcribe] done', {
      runStatus: run.status,
      documentStatus: document.status,
      counts: document.counts
    })
    if (run.status !== 'complete') {
      process.exitCode = 1
    }
  } catch (err) {
    console.error('[transcribe] processing failed', err)
    process.exitCode = 1
  } finally {
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  await main()
}
