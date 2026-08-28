#!/usr/bin/env node
import fs from 'node:fs'

const args = process.argv.slice(2)
const scenario = process.env.FAKE_CODEX_SCENARIO ?? 'success'

if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('codex-cli 0.147.0\n')
  process.exit(0)
}

if (args[0] === 'login' && args[1] === 'status') {
  if (scenario === 'login-unauthenticated') {
    process.stderr.write('Not logged in\n')
    process.exit(1)
  }
  process.stdout.write('Logged in using ChatGPT\n')
  process.exit(0)
}

if (process.env.FAKE_CODEX_ARGUMENT_LOG) {
  fs.writeFileSync(process.env.FAKE_CODEX_ARGUMENT_LOG, JSON.stringify(args), {
    mode: 0o600
  })
}
if (process.env.FAKE_CODEX_PID_PATH) {
  fs.writeFileSync(process.env.FAKE_CODEX_PID_PATH, String(process.pid), {
    mode: 0o600
  })
}

const outputIndex = args.indexOf('--output-last-message')
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined
const prompt = args.at(-1) ?? ''
const pageIds = prompt.match(/c\d{6}/g) ?? []

function event(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function writeOutput(value) {
  if (outputPath)
    fs.writeFileSync(outputPath, JSON.stringify(value), { mode: 0o600 })
}

function validOutput(ids) {
  return {
    schemaVersion: '1',
    pages: ids.map((pageId) => ({ pageId, blocks: [], warnings: [] }))
  }
}

event({ type: 'thread.started', thread_id: 'fake' })
event({ type: 'turn.started' })

if (scenario === 'turn-failed-exit-zero') {
  event({ type: 'turn.failed', error: { message: 'fake failure' } })
  process.exit(0)
}

if (scenario === 'nonzero') {
  process.stderr.write('fake process error\n')
  process.exit(2)
}

if (scenario === 'rate-limit') {
  event({ type: 'turn.failed', error: { message: 'rate limit exceeded' } })
  process.exit(1)
}

if (scenario === 'stderr-overflow') {
  process.stderr.write('x'.repeat(2_048))
  process.exit(0)
}

if (scenario === 'stdout-overflow') {
  process.stdout.write('x'.repeat(2_048))
  process.exit(0)
}

if (scenario === 'hang-term' || scenario === 'hang-ignore-term') {
  if (scenario === 'hang-term') process.on('SIGTERM', () => process.exit(0))
  process.on('SIGTERM', () => undefined)
  setInterval(() => undefined, 1000)
}

if (scenario === 'missing-output') {
  event({ type: 'turn.completed' })
  process.exit(0)
}

if (scenario === 'malformed-output') {
  if (outputPath) fs.writeFileSync(outputPath, '{', { mode: 0o600 })
  event({ type: 'turn.completed' })
  process.exit(0)
}

if (scenario === 'wrong-page-ids') {
  writeOutput(validOutput([...pageIds].reverse()))
  event({ type: 'turn.completed' })
  process.exit(0)
}

if (scenario === 'result-overflow') {
  if (outputPath) fs.writeFileSync(outputPath, 'x'.repeat(2_048), { mode: 0o600 })
  event({ type: 'turn.completed' })
  process.exit(0)
}

writeOutput(validOutput(pageIds))
event({ type: 'turn.completed' })
