// Runs a headless coding agent: Claude Code (`claude -p`) or Codex (`codex exec`).
// Both run lean: no user plugins, MCP servers or user config. With those loaded, a trivial
// Claude Haiku call measured ~16x more expensive (see docs/PAPER.md §4).
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Engine } from './types.ts'

export interface AgentCall {
  engine: Engine
  model: string
  prompt: string
  cwd: string
  // "read": inspect only. "write": may edit files and run the allowlisted commands.
  access: 'read' | 'write'
  // Replaces the harness system prompt (Claude) or is prepended to the prompt (Codex).
  systemPrompt?: string
  // Added to the harness system prompt (Claude) or prepended to the prompt (Codex).
  appendSystemPrompt?: string
  // Shell commands a writing agent may run without asking (Claude only; Codex relies on its sandbox).
  allowedCommands?: string[]
  schema?: object
  budgetUsd?: number
  effort?: string
}

export interface AgentResult {
  ok: boolean
  text: string
  structured: unknown
  // Claude reports dollars. Codex reports only tokens, so costUsd stays 0 and tokens is set.
  costUsd: number
  tokens: number
  ms: number
  error: string | null
}

export function runAgent(call: AgentCall): Promise<AgentResult> {
  return call.engine === 'codex' ? runCodex(call) : runClaude(call)
}

// ---------------------------------------------------------------------------- Claude Code

const CLAUDE_LEAN = [
  '--no-session-persistence',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', 'project',
  '--disable-slash-commands',
]

export function claudeArgs(call: AgentCall): string[] {
  const args = ['-p', '--output-format', 'json', '--model', call.model, ...CLAUDE_LEAN]
  if (call.systemPrompt) args.push('--system-prompt', call.systemPrompt)
  if (call.appendSystemPrompt) args.push('--append-system-prompt', call.appendSystemPrompt)
  if (call.access === 'read') {
    args.push('--tools', 'Read,Grep,Glob')
  } else {
    const bash = (call.allowedCommands ?? []).map(c => `Bash(${c}*)`)
    args.push('--tools', 'Read,Edit,Write,Grep,Glob,Bash')
    args.push('--allowedTools', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash(git diff*)', 'Bash(git status*)', 'Bash(ls*)', ...bash)
    // Anything outside the allowlist is denied rather than prompted: there is no human in the loop.
    args.push('--permission-mode', 'dontAsk')
  }
  if (call.schema) args.push('--json-schema', JSON.stringify(call.schema))
  if (call.budgetUsd) args.push('--max-budget-usd', String(call.budgetUsd))
  if (call.effort) args.push('--effort', call.effort)
  return args
}

async function runClaude(call: AgentCall): Promise<AgentResult> {
  const bin = process.env.MEGAPROBE_CLAUDE_BIN || 'claude'
  const started = Date.now()
  const p = await exec(bin, claudeArgs(call), call.cwd, call.prompt)
  if (p.spawnError) return fail(`could not start ${bin}: ${p.spawnError}`, started)
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(p.stdout)
  } catch {
    return fail(`${bin} exited ${p.code}: ${(p.stderr || p.stdout).trim().slice(-500)}`, started)
  }
  const isError = parsed.is_error === true || parsed.subtype !== 'success'
  return {
    ok: !isError,
    text: typeof parsed.result === 'string' ? parsed.result : '',
    structured: parsed.structured_output ?? null,
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0,
    tokens: tokenSum(parsed.usage),
    ms: Date.now() - started,
    error: isError ? String(parsed.result || parsed.subtype || 'unknown error') : null,
  }
}

// ---------------------------------------------------------------------------- Codex

export function codexArgs(call: AgentCall, files: { schema: string; last: string }): string[] {
  const args = [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '-C', call.cwd,
    '-m', call.model,
    '-s', call.access === 'read' ? 'read-only' : 'workspace-write',
    '-o', files.last,
  ]
  if (call.schema) args.push('--output-schema', files.schema)
  if (call.effort) args.push('-c', `model_reasoning_effort="${call.effort}"`)
  args.push('-')
  return args
}

async function runCodex(call: AgentCall): Promise<AgentResult> {
  const bin = process.env.MEGAPROBE_CODEX_BIN || 'codex'
  const started = Date.now()
  const dir = mkdtempSync(join(tmpdir(), 'megaprobe-'))
  const files = { schema: join(dir, 'schema.json'), last: join(dir, 'last.txt') }
  try {
    if (call.schema) writeFileSync(files.schema, JSON.stringify(call.schema))
    const preamble = [call.systemPrompt, call.appendSystemPrompt].filter(Boolean).join('\n\n')
    const prompt = preamble ? `${preamble}\n\n---\n\n${call.prompt}` : call.prompt
    const p = await exec(bin, codexArgs(call, files), call.cwd, prompt)
    if (p.spawnError) return fail(`could not start ${bin}: ${p.spawnError}`, started)

    let tokens = 0
    let error: string | null = null
    for (const line of p.stdout.split('\n')) {
      if (!line.startsWith('{')) continue
      try {
        const ev = JSON.parse(line) as { type?: string; usage?: unknown; error?: { message?: string }; message?: string }
        if (ev.type === 'turn.completed') tokens += tokenSum(ev.usage)
        if (ev.type === 'turn.failed' || ev.type === 'error') error = ev.error?.message ?? ev.message ?? 'codex error'
      } catch {}
    }
    let text = ''
    try { text = readFileSync(files.last, 'utf8').trim() } catch {}
    if (p.code !== 0 && !error) error = `${bin} exited ${p.code}: ${p.stderr.trim().slice(-500)}`

    let structured: unknown = null
    if (call.schema && text) {
      try { structured = JSON.parse(text) } catch { error ??= 'final message was not valid JSON' }
    }
    return { ok: !error, text, structured, costUsd: 0, tokens, ms: Date.now() - started, error }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------- helpers

function exec(bin: string, args: string[], cwd: string, input: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; spawnError: string | null }>(resolve => {
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    child.on('error', e => resolve({ code: null, stdout, stderr, spawnError: e.message }))
    child.on('close', code => resolve({ code, stdout, stderr, spawnError: null }))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

function tokenSum(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0
  let n = 0
  for (const [k, v] of Object.entries(usage)) if (typeof v === 'number' && k.endsWith('tokens')) n += v
  return n
}

function fail(error: string, started: number): AgentResult {
  return { ok: false, text: '', structured: null, costUsd: 0, tokens: 0, ms: Date.now() - started, error }
}
