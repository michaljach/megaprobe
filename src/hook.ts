#!/usr/bin/env node
// In-session mode: the user keeps working in Claude Code; the session model orchestrates and
// megaprobe's subagents do the exploring and the editing. Everything that must be deterministic
// happens here, in code: profile context, claim verification, tier choice, checks, escalation.
//
// Usage (from hooks/hooks.json): node src/hook.ts <SessionStart|PreToolUse|SubagentStop|PostToolUse>
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { plannedChecks, runChecks } from './check.ts'
import { loadConfig, stateDir } from './config.ts'
import { decide, nextTier } from './decide.ts'
import { detectStack, listFiles } from './detect.ts'
import { wantsPipeline } from './intent.ts'
import { fingerprint, profileContext, readCachedProfile, repoDigest, saveProfile } from './profile.ts'
import { changedFiles, saveRun } from './run.ts'
import { parseHandoff, scoutPrompt } from './scout.ts'
import { verifyHandoff } from './verify.ts'
import { workerBrief } from './worker.ts'
import type { PreviousAttempt } from './worker.ts'
import type { Attempt, Config, Profile, RunLog, Verified } from './types.ts'

const AGENT = { scout: 'megaprobe:scout', worker: 'megaprobe:worker', profiler: 'megaprobe:profiler' }

interface HookInput {
  prompt?: string
  session_id?: string
  cwd?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  agent_type?: string
  last_assistant_message?: string
  stop_hook_active?: boolean
}

// Per-session pipeline state. One pipeline at a time: calling the scout starts a new one.
interface Session {
  task: string | null
  startedAt: string | null
  verified: Verified | null
  decision: { tier: string; reason: string } | null
  tier: string | null
  previous: PreviousAttempt | null
  attempts: Attempt[]
  scoutFailed: boolean
  lastMessage: string | null
  // Hash of the scout reply already verified; SubagentStop can fire more than once for it.
  scoutHash: string | null
}

const EMPTY: Session = {
  task: null, startedAt: null, verified: null, decision: null, tier: null,
  previous: null, attempts: [], scoutFailed: false, lastMessage: null, scoutHash: null,
}

export async function handle(event: string, input: HookInput): Promise<object | null> {
  const root = gitRoot(input.cwd ?? process.cwd())
  const cfg = loadConfig(root, 'claude')
  const session = loadSession(root, input.session_id)
  const agent = String(input.tool_input?.subagent_type ?? input.agent_type ?? '')

  switch (event) {
    case 'SessionStart': {
      const profile = currentProfile(root)
      const lines = [
        cfg.auto === 'off'
          ? 'megaprobe is installed. The user can run code changes through it with /megaprobe:run.'
          : 'megaprobe is active in this project. Code-change requests go through the megaprobe:run skill: a cheap scout explores, megaprobe verifies its claims, and the cheapest fitting worker makes the change, with checks and escalation.',
        profileContext(profile),
      ]
      if (!profile.summary) lines.push('No project profile yet. Suggest /megaprobe:profile to the user once; it improves every later run.')
      return context('SessionStart', lines.join('\n'))
    }

    case 'UserPromptSubmit': {
      if (!wantsPipeline(input.prompt ?? '', cfg.auto)) return null
      if (!Object.values(currentProfile(root).stack.checks).some(Boolean)) return null
      return context('UserPromptSubmit', AUTO_HINT)
    }

    case 'PreToolUse': {
      const ti = input.tool_input ?? {}
      const prompt = String(ti.prompt ?? '')
      if (agent === AGENT.scout) {
        saveSession(root, input.session_id, { ...EMPTY, task: prompt, startedAt: new Date().toISOString() })
        return updatedInput({ ...ti, prompt: scoutPrompt(prompt, currentProfile(root)) })
      }
      if (agent === AGENT.profiler) {
        const files = listFiles(root)
        return updatedInput({ ...ti, prompt: repoDigest(root, files, detectStack(root, files)) })
      }
      if (agent === AGENT.worker) {
        if (!session.verified || !session.tier || !session.task) {
          return deny('megaprobe: no verified handoff in this session. Call the megaprobe:scout agent with the task first.')
        }
        const tier = cfg.tiers[session.tier]
        if (!tier) return deny(`megaprobe: unknown tier "${session.tier}" in .megaprobe/config.json`)
        const brief = workerBrief(session.task, currentProfile(root), session.verified, session.previous)
        return updatedInput({ ...ti, model: tier.model, prompt: brief }, `megaprobe: worker runs on the ${session.tier} tier (${tier.model}).`)
      }
      return null
    }

    case 'SubagentStop': {
      const text = input.last_assistant_message ?? ''
      if (agent === AGENT.scout) {
        const hash = createHash('sha1').update(text).digest('hex')
        if (session.scoutHash === hash && session.verified) return null
        const handoff = parseHandoff(text)
        if (!handoff) {
          // Give the scout one chance to produce the block, then fall back.
          if (!input.stop_hook_active) return { decision: 'block', reason: 'End your reply with the handoff as one fenced ```json block, in the format from your instructions.' }
          saveSession(root, input.session_id, { ...session, scoutFailed: true })
          return null
        }
        const profile = currentProfile(root)
        const verified = verifyHandoff(root, handoff, profile.stack.checks, { timeoutMs: cfg.checkTimeoutMs })
        const decision = decide(verified.handoff, cfg)
        saveSession(root, input.session_id, { ...session, verified, decision, tier: decision.tier, attempts: [], previous: null, scoutFailed: false, scoutHash: hash })
        return null
      }
      if (agent === AGENT.profiler) {
        const summary = text.trim()
        if (summary) saveProfile(root, { ...currentProfile(root), summary, createdAt: new Date().toISOString() })
        return null
      }
      if (agent === AGENT.worker) saveSession(root, input.session_id, { ...session, lastMessage: text.slice(-2000) })
      return null
    }

    case 'PostToolUse': {
      if (agent === AGENT.scout) return context('PostToolUse', scoutReport(session, cfg))
      if (agent === AGENT.profiler) return context('PostToolUse', 'megaprobe saved the project profile to .megaprobe/profile.md. It is loaded into every new session and every scout run.')
      if (agent === AGENT.worker && session.tier && session.verified) return context('PostToolUse', afterWorker(root, input.session_id, session, cfg))
      return null
    }
  }
  return null
}

const AUTO_HINT = `megaprobe: this looks like a request to change code. Unless it is really a question, needs discussion first, or is a one-line edit you can make without reading any files, handle it by invoking the megaprobe:run skill with the user's request as its argument instead of exploring and editing yourself. If the user said not to use megaprobe, ignore this.`

function scoutReport(s: Session, cfg: Config): string {
  if (s.scoutFailed || !s.verified || !s.decision) {
    return 'megaprobe: the scout did not return a usable handoff. Do the task directly, or retry megaprobe:scout with a more specific task.'
  }
  const v = s.verified
  const lines = [
    `megaprobe verified the scout's handoff: kept ${v.handoff.relevant_files.length} file(s) and ${v.handoff.symbols.length} symbol(s), removed ${v.removed.length} claim(s).`,
    ...v.removed.map(r => `- removed ${r.claim}: ${r.reason}`),
    v.repro ? `Repro \`${v.repro.command}\` exited ${v.repro.exit} (${v.repro.matched ? 'as the scout expected' : 'not as expected, removed'}).` : '',
    `Task: ${v.handoff.task_type}, ${v.handoff.difficulty}. Decided tier: ${s.decision.tier} (${cfg.tiers[s.decision.tier]?.model}) by ${s.decision.reason}.`,
    v.handoff.task_type === 'question'
      ? 'This is a question: answer the user from the handoff, reading at most the files it names. No worker needed.'
      : 'Next: call the megaprobe:worker agent with the task as its prompt. megaprobe sets the model and gives it the verified handoff. Do not make the change yourself.',
  ]
  return lines.filter(Boolean).join('\n')
}

function afterWorker(root: string, sessionId: string | undefined, s: Session, cfg: Config): string {
  const profile = currentProfile(root)
  const tier = s.tier as string
  const model = cfg.tiers[tier]?.model ?? '?'
  const changed = changedFiles(root)
  const planned = plannedChecks(profile.stack.checks, s.verified?.handoff ?? null, changed)
  const checks = planned.length ? runChecks(root, planned, cfg.checkTimeoutMs) : []
  const failed = checks.find(c => c.exit !== 0)
  const attempt: Attempt = {
    tier, engine: 'claude', model, costUsd: 0, tokens: 0, ms: 0, workerError: null,
    checks, passed: !failed && planned.length > 0,
  }
  const attempts = [...s.attempts, attempt]
  const summary = checks.map(c => `${c.exit === 0 ? 'pass' : 'FAIL'} ${c.name} (\`${c.command}\`)`).join(', ')

  if (!planned.length) {
    finishRun(root, { ...s, attempts }, 'no_checks')
    saveSession(root, sessionId, { ...s, attempts })
    return 'megaprobe: no check commands detected, so the change is unverified. Set "checks" in .megaprobe/config.json. Review the diff yourself before reporting.'
  }
  if (!failed) {
    finishRun(root, { ...s, attempts }, 'passed')
    saveSession(root, sessionId, { ...EMPTY })
    return `megaprobe checks passed on the ${tier} tier (${model}): ${summary}.\nReview \`git diff\` briefly for scope and quality, then report to the user.`
  }

  const next = nextTier(tier, cfg)
  const escalations = attempts.length - 1
  if (!next || escalations >= cfg.maxEscalations) {
    finishRun(root, { ...s, attempts }, 'failed')
    saveSession(root, sessionId, { ...EMPTY })
    return `megaprobe checks still fail after ${attempts.length} attempt(s), last on ${tier} (${model}): ${summary}.\n$ ${failed.command}\n${failed.tail.slice(-1500)}\nStop and report this to the user; do not keep retrying.`
  }
  const diff = spawnSync('git', ['diff', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout ?? ''
  saveSession(root, sessionId, { ...s, attempts, tier: next, previous: { tier, diff, failed } })
  return `megaprobe checks failed on the ${tier} tier (${model}): ${summary}.\n$ ${failed.command}\n${failed.tail.slice(-1500)}\nmegaprobe escalated to the ${next} tier (${cfg.tiers[next]?.model}). Call megaprobe:worker again with the same task; it will get the failure and the previous diff.`
}

function finishRun(root: string, s: Session, outcome: RunLog['outcome']): void {
  const started = s.startedAt ? Date.parse(s.startedAt) : Date.now()
  saveRun(root, {
    id: new Date().toISOString().replace(/[:.]/g, '-'),
    task: s.task ?? '',
    startedAt: s.startedAt ?? new Date().toISOString(),
    profileCached: true,
    // In-session the harness does not expose per-subagent cost to hooks.
    scout: { engine: 'claude', model: 'megaprobe:scout', costUsd: 0, tokens: 0, ms: 0, error: null },
    verified: s.verified,
    decision: s.decision,
    attempts: s.attempts,
    outcome,
    totalCostUsd: 0,
    totalMs: Date.now() - started,
  })
}

// Stack detection is cheap, so the in-session profile is always fresh; the summary is kept across
// fingerprint changes because a stale summary still beats none (the profiler refreshes it).
function currentProfile(root: string): Profile {
  const files = listFiles(root)
  const fp = fingerprint(root, files)
  const cached = readCachedProfile(root)
  if (cached && cached.fingerprint === fp) return cached
  const cfg = loadConfig(root, 'claude')
  const stack = detectStack(root, files)
  stack.checks = { ...stack.checks, ...cfg.checks }
  const profile: Profile = { fingerprint: fp, stack, summary: cached?.summary ?? null, createdAt: new Date().toISOString(), costUsd: 0 }
  saveProfile(root, profile)
  return profile
}

function sessionFile(root: string, id: string | undefined): string {
  return join(stateDir(root), 'sessions', `${(id ?? 'default').replace(/[^\w-]/g, '')}.json`)
}

function loadSession(root: string, id: string | undefined): Session {
  const f = sessionFile(root, id)
  return existsSync(f) ? { ...EMPTY, ...(JSON.parse(readFileSync(f, 'utf8')) as Partial<Session>) } : { ...EMPTY }
}

function saveSession(root: string, id: string | undefined, s: Session): void {
  const f = sessionFile(root, id)
  mkdirSync(join(stateDir(root), 'sessions'), { recursive: true })
  writeFileSync(f, JSON.stringify(s, null, 2))
}

function gitRoot(cwd: string): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : cwd
}

const context = (event: string, text: string) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })
const updatedInput = (input: object, note?: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: input, ...(note ? { additionalContext: note } : {}) },
})
const deny = (reason: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
})

async function main(): Promise<void> {
  const event = process.argv[2] ?? ''
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try {
    const input = raw ? (JSON.parse(raw) as HookInput) : {}
    const out = await handle(event, input)
    if (out) process.stdout.write(JSON.stringify(out))
    // MEGAPROBE_DEBUG=<file> records what the harness sent and what megaprobe answered.
    if (process.env.MEGAPROBE_DEBUG) appendFileSync(process.env.MEGAPROBE_DEBUG, JSON.stringify({ event, input, out }) + '\n')
  } catch (err) {
    // Fail open: a broken hook must never block the user's session.
    process.stderr.write(`megaprobe hook error (${event}): ${err instanceof Error ? err.message : err}\n`)
  }
  process.exit(0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
