import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handle } from '../src/hook.ts'
import { wantsPipeline } from '../src/intent.ts'
import { makeRepo } from './helpers.ts'

const CHANGES = [
  'add(1, 2) returns -1 instead of 3, fix it',
  'Can you fix the login redirect bug?',
  'please rename verifyToken to verifyJwt everywhere',
  'Refactor the auth middleware to use the new session store',
  'The checkout button does nothing on mobile. Make it work.',
  'Review and fix the error handling in src/api',
]
const NOT_CHANGES = [
  'How do I add a new route here?',
  'What does verifyToken return when the token is expired?',
  'explain the build pipeline',
  '/megaprobe:profile',
  '!git status',
  'thanks!',
  'fix it but without megaprobe this time',
]

test('smart mode suggests the pipeline for change requests only', () => {
  for (const p of CHANGES) assert.equal(wantsPipeline(p, 'smart'), true, p)
  for (const p of NOT_CHANGES) assert.equal(wantsPipeline(p, 'smart'), false, p)
})

test('always and off modes, and explicit mentions', () => {
  assert.equal(wantsPipeline('explain the build pipeline', 'always'), true)
  assert.equal(wantsPipeline('fix the login bug please', 'off'), false)
  assert.equal(wantsPipeline('use megaprobe to look at this', 'smart'), true)
})

test('UserPromptSubmit hook adds the hint for change requests in a repo with checks', async () => {
  const root = makeRepo()
  const out = await handle('UserPromptSubmit', { session_id: 'u', cwd: root, prompt: 'Can you fix the add function?' }) as { hookSpecificOutput?: { additionalContext?: string } }
  assert.match(out.hookSpecificOutput?.additionalContext ?? '', /invoking the megaprobe:run skill/)
  assert.equal(await handle('UserPromptSubmit', { session_id: 'u', cwd: root, prompt: 'What does add do?' }), null)
})
