// Headless mode end to end with fake `claude` and `codex` binaries (no model calls, no cost).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { HANDOFF, makeRepo } from './helpers.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const STUBS = fileURLToPath(new URL('./stubs/', import.meta.url))

function cli(root: string, args: string[], env: Record<string, string>) {
  const handoff = join(root, '..', `handoff-${Date.now()}.json`)
  writeFileSync(handoff, JSON.stringify(HANDOFF))
  const r = spawnSync('node', [CLI, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, MEGAPROBE_CLAUDE_BIN: STUBS + 'claude.mjs', MEGAPROBE_CODEX_BIN: STUBS + 'codex.mjs', STUB_HANDOFF: handoff, ...env },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

test('claude engine: fast worker fails checks, standard fixes it', () => {
  const root = makeRepo()
  const log = join(root, '..', `calls-${Date.now()}.jsonl`)
  const r = cli(root, ['run', 'fix add'], { STUB_FIX_MODELS: 'sonnet', STUB_LOG: log })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /PASSED\s+attempts: fast\(fail\) > standard\(pass\)\s+cost: \$0\.04/)
  assert.match(r.err, /removed 2 claim/)
  const models = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l).model)
  assert.deepEqual(models, ['sonnet', 'haiku', 'haiku', 'sonnet'], 'profile, scout, fast worker, standard worker')
  const workerArgs = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[2] as string).args as string[]
  assert.ok(workerArgs.includes('dontAsk') && workerArgs.includes('--strict-mcp-config'))
})

test('codex engine: same pipeline through codex exec, tokens instead of dollars', () => {
  const root = makeRepo()
  const r = cli(root, ['run', '--engine', 'codex', '--no-llm', 'fix add'], { STUB_FIX_MODELS: 'gpt-5.6-luna' })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /PASSED\s+attempts: fast\(pass\)/)
  assert.match(r.err, /codex\/gpt-5\.6-luna/)
  assert.match(r.err, /\d+ tokens/)
  assert.match(r.out, /tokens: 1040/)
})

test('refuses a dirty tree, and scout makes no changes', () => {
  const root = makeRepo()
  writeFileSync(join(root, 'src/greet.js'), '// edited\n')
  assert.match(cli(root, ['run', 'fix add'], {}).err, /uncommitted changes/)
  const s = cli(root, ['scout', '--no-llm', 'fix add'], {})
  assert.equal(s.code, 0, s.err)
  assert.equal(JSON.parse(s.out).relevant_files.length, 1)
})
