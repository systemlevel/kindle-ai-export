#!/usr/bin/env node
// Minimal stand-in for the Claude Code CLI (`claude`) used by the unit tests.
// It understands the three invocations the Claude page analyzer makes:
//   claude --version
//   claude auth status
//   claude -p [flags...] <prompt>
// and emits the `--output-format json` result envelope for the last one.
import fs from 'node:fs'

const args = process.argv.slice(2)
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'success'

if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('2.1.257 (Claude Code)\n')
  process.exit(0)
}

if (args[0] === 'auth' && args[1] === 'status') {
  const loggedIn = scenario !== 'not-logged-in'
  process.stdout.write(
    `${JSON.stringify({
      loggedIn,
      authMethod: loggedIn ? 'claude.ai' : 'none',
      apiProvider: 'firstParty'
    })}\n`
  )
  // The real CLI prints the status JSON and exits non-zero when logged out.
  process.exit(loggedIn ? 0 : 1)
}

if (process.env.FAKE_CLAUDE_ARGUMENT_LOG) {
  fs.writeFileSync(process.env.FAKE_CLAUDE_ARGUMENT_LOG, JSON.stringify(args), {
    mode: 0o600
  })
}
if (process.env.FAKE_CLAUDE_PID_PATH) {
  fs.writeFileSync(process.env.FAKE_CLAUDE_PID_PATH, String(process.pid), {
    mode: 0o600
  })
}

const pageResult = {
  text: 'Claude page text',
  visuals: [
    {
      kind: 'chart',
      description: 'A rising line chart.',
      region: { x: 100, y: 200, width: 300, height: 400 }
    }
  ]
}

function envelope(overrides) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1234,
    num_turns: 2,
    session_id: 'fake-session',
    total_cost_usd: 0,
    result: JSON.stringify(pageResult),
    ...overrides
  }
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

switch (scenario) {
  case 'nonzero': {
    process.stderr.write('fake claude process error\n')
    process.exit(2)
    break
  }
  case 'hang': {
    process.on('SIGTERM', () => process.exit(0))
    setInterval(() => undefined, 1000)
    break
  }
  case 'malformed': {
    process.stdout.write('this is not json\n')
    process.exit(0)
    break
  }
  case 'is-error': {
    emit(
      envelope({
        is_error: true,
        result: 'Failed to authenticate: OAuth session expired'
      })
    )
    process.exit(0)
    break
  }
  case 'error-subtype': {
    emit(envelope({ subtype: 'error_max_turns', result: '' }))
    process.exit(0)
    break
  }
  case 'result-text-json': {
    emit(envelope({}))
    process.exit(0)
    break
  }
  case 'result-plain-text': {
    emit(envelope({ result: 'Just some transcribed prose.' }))
    process.exit(0)
    break
  }
  default: {
    emit(envelope({ structured_output: pageResult }))
    process.exit(0)
  }
}
