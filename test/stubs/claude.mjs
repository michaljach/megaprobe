#!/usr/bin/env node
// Fake `claude -p`: the scout call (has --json-schema) returns STUB_HANDOFF; a worker call fixes
// src/math.js only when its model is listed in STUB_FIX_MODELS, so escalation can be exercised.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const model = args[args.indexOf('--model') + 1]
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, JSON.stringify({ model, args }) + '\n')
let structured = null
if (args.includes('--json-schema')) structured = JSON.parse(readFileSync(process.env.STUB_HANDOFF, 'utf8'))
else if (args.includes('--append-system-prompt') && (process.env.STUB_FIX_MODELS ?? '').split(',').includes(model)) writeFileSync('src/math.js', 'export const add = (a, b) => a + b\n')
const isProfile = !structured && args.includes('--system-prompt') && !args.includes('--append-system-prompt')
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, num_turns: 2,
  result: isProfile ? '## Architecture\nstub profile' : structured ? JSON.stringify(structured) : 'done',
  structured_output: structured, total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 10 },
}))
