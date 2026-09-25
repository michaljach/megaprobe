// Replays what Claude Code sends to the hooks during one /megaprobe:run, including an escalation.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { handle } from '../src/hook.ts'
import { FIXED, HANDOFF, makeRepo } from './helpers.ts'

type Out = { hookSpecificOutput?: { additionalContext?: string; updatedInput?: Record<string, unknown>; permissionDecision?: string }; decision?: string }
const ctx = (o: object | null) => (o as Out | null)?.hookSpecificOutput?.additionalContext ?? ''
const upd = (o: object | null) => (o as Out | null)?.hookSpecificOutput?.updatedInput ?? {}

test('in-session pipeline: scout -> verify -> fast worker fails -> escalate -> standard passes', async () => {
  const root = makeRepo()
  const base = { session_id: 's1', cwd: root }
  const task = 'add(1, 2) returns -1, fix it'

  assert.match(ctx(await handle('SessionStart', base)), /megaprobe is active[\s\S]*react/)

  const denied = await handle('PreToolUse', { ...base, tool_name: 'Agent', tool_input: { subagent_type: 'megaprobe:worker', prompt: task } })
  assert.equal((denied as Out).hookSpecificOutput?.permissionDecision, 'deny', 'worker before scout is refused')

  const scoutIn = upd(await handle('PreToolUse', { ...base, tool_name: 'Agent', tool_input: { subagent_type: 'megaprobe:scout', prompt: task } }))
  assert.match(String(scoutIn.prompt), /# Task[\s\S]*Checks: .*npm run test/)

  const nudge = await handle('SubagentStop', { ...base, agent_type: 'megaprobe:scout', last_assistant_message: 'no block', stop_hook_active: false })
  assert.equal((nudge as Out).decision, 'block', 'scout is asked once for the json block')

  const reply = `Found it.\n\`\`\`json\n${JSON.stringify(HANDOFF)}\n\`\`\``
  await handle('SubagentStop', { ...base, agent_type: 'megaprobe:scout', last_assistant_message: reply, stop_hook_active: true })
  const report = ctx(await handle('PostToolUse', { ...base, tool_name: 'Agent', tool_input: { subagent_type: 'megaprobe:scout', prompt: task } }))
  assert.match(report, /removed 2 claim/)
  assert.match(report, /src\/nope\.js/)
  assert.match(report, /Decided tier: fast \(haiku\)/)

  const w1 = upd(await handle('PreToolUse', { ...base, tool_name: 'Agent', tool_input: { subagent_type: 'megaprobe:worker', prompt: task } }))
  assert.equal(w1.model, 'haiku')
  assert.match(String(w1.prompt), /Handoff \(verified by megaprobe\)/)
  assert.doesNotMatch(String(w1.prompt), /"path": "src\/nope\.js"/, 'invented file never reaches the worker')

  // Fast worker changes nothing useful: checks fail and megaprobe escalates.
  const after1 = ctx(await handle('PostToolUse', { ...base, tool_name: 'Agent', tool_input: { subagent_type: 'megaprobe:worker' } }))
  assert.match(after1, /FAIL tests[\s\S]*escalated to the standard tier \(sonnet\)/)

  const w2 = upd(await handle('PreToolUse', { ...base, tool_name: 'Agent', tool_input: { subagent_type: 'megaprobe:worker', prompt: task } }))
  assert.equal(w2.model, 'sonnet')
  assert.match(String(w2.prompt), /Previous attempt \(fast tier\) failed tests[\s\S]*add broken/)

  writeFileSync(join(root, 'src/math.js'), FIXED)
  const after2 = ctx(await handle('PostToolUse', { ...base, tool_name: 'Agent', tool_input: { subagent_type: 'megaprobe:worker' } }))
  assert.match(after2, /checks passed on the standard tier/)

  const runs = readdirSync(join(root, '.megaprobe/runs'))
  assert.equal(runs.length, 1)
  const log = JSON.parse(readFileSync(join(root, '.megaprobe/runs', runs[0] as string), 'utf8'))
  assert.equal(log.outcome, 'passed')
  assert.deepEqual(log.attempts.map((a: { tier: string }) => a.tier), ['fast', 'standard'])
})

test('profiler output is saved by the hook, and unrelated agents are ignored', async () => {
  const root = makeRepo()
  const base = { session_id: 's2', cwd: root }
  const pin = upd(await handle('PreToolUse', { ...base, tool_name: 'Agent', tool_input: { subagent_type: 'megaprobe:profiler', prompt: 'Write the project profile.' } }))
  assert.match(String(pin.prompt), /## Files \(\d+\)[\s\S]*src\/math\.js/)
  await handle('SubagentStop', { ...base, agent_type: 'megaprobe:profiler', last_assistant_message: '## Architecture\nTiny demo.' })
  assert.match(readFileSync(join(root, '.megaprobe/profile.md'), 'utf8'), /Tiny demo/)
  assert.doesNotMatch(ctx(await handle('SessionStart', base)), /No project profile yet/)
  assert.equal(await handle('PreToolUse', { ...base, tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'x' } }), null)
})
