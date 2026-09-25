#!/usr/bin/env node
// Fake `codex exec`: writes the final message to -o, emits JSONL events with token usage.
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const model = args[args.indexOf('-m') + 1]
const out = args[args.indexOf('-o') + 1]
if (args.includes('--output-schema')) writeFileSync(out, readFileSync(process.env.STUB_HANDOFF, 'utf8'))
else {
  if ((process.env.STUB_FIX_MODELS ?? '').split(',').includes(model)) writeFileSync('src/math.js', 'export const add = (a, b) => a + b\n')
  writeFileSync(out, 'done')
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 't' }))
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 500, output_tokens: 20 } }))
