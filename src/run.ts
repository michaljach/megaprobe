// The pipeline: profile -> scout -> verify -> decide -> work -> check -> escalate.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { plannedChecks, runChecks } from './check.ts'
import { stateDir } from './config.ts'
import { decide, nextTier } from './decide.ts'
import { loadProfile } from './profile.ts'
import { scout } from './scout.ts'
import { verifyHandoff } from './verify.ts'
import { work } from './worker.ts'
import type { PreviousAttempt } from './worker.ts'
import type { Attempt, Config, RunLog } from './types.ts'

export interface RunOptions {
  dryRun?: boolean
  allowDirty?: boolean
  llmProfile?: boolean
  tier?: string
  log?: (line: string) => void
}

export async function runPipeline(root: string, task: string, cfg: Config, opts: RunOptions = {}): Promise<RunLog> {
  const say = opts.log ?? (() => {})
  const started = Date.now()
  if (!opts.dryRun && !opts.allowDirty && dirty(root)) {
    throw new Error('working tree has uncommitted changes; commit or stash them, or pass --allow-dirty')
  }

  const log: RunLog = {
    id: new Date().toISOString().replace(/[:.]/g, '-'),
    task,
    startedAt: new Date().toISOString(),
    profileCached: false,
    scout: { engine: cfg.scout.engine ?? cfg.engine, model: cfg.scout.model, costUsd: 0, tokens: 0, ms: 0, error: null },
    verified: null,
    decision: null,
    attempts: [],
    outcome: 'failed',
    totalCostUsd: 0,
    totalMs: 0,
  }
  let profileCostUsd = 0
  const finish = (outcome: RunLog['outcome']) => {
    log.outcome = outcome
    log.totalMs = Date.now() - started
    log.totalCostUsd = round(profileCostUsd + log.scout.costUsd + log.attempts.reduce((s, a) => s + a.costUsd, 0))
    saveRun(root, log)
    return log
  }

  say('profile  loading')
  const { profile, cached } = await loadProfile(root, cfg, { llm: opts.llmProfile })
  log.profileCached = cached
  if (!cached) profileCostUsd = profile.costUsd
  say(`profile  ${cached ? 'cached' : `built ($${round(profile.costUsd)})`}: ${profile.stack.frameworks.join(', ') || 'no frameworks'}`)

  say(`scout    ${cfg.scout.engine ?? cfg.engine}/${cfg.scout.model} exploring`)
  const s = await scout(root, task, profile, cfg)
  log.scout = { engine: cfg.scout.engine ?? cfg.engine, model: cfg.scout.model, costUsd: s.res.costUsd, tokens: s.res.tokens, ms: s.res.ms, error: s.handoff ? null : s.res.error ?? 'no handoff returned' }
  if (!s.handoff) {
    say(`scout    failed: ${log.scout.error}`)
    return finish('scout_failed')
  }
  say(`scout    ${s.handoff.task_type}/${s.handoff.difficulty}, ${s.handoff.relevant_files.length} files (${spend(s.res)}, ${secs(s.res.ms)})`)

  const verified = verifyHandoff(root, s.handoff, profile.stack.checks, { runRepro: !opts.dryRun, timeoutMs: cfg.checkTimeoutMs })
  log.verified = verified
  say(`verify   kept ${verified.handoff.relevant_files.length} files, ${verified.handoff.symbols.length} symbols; removed ${verified.removed.length} claim(s)`)
  for (const r of verified.removed) say(`         - ${r.claim}: ${r.reason}`)

  const decision = opts.tier && cfg.tiers[opts.tier] ? { tier: opts.tier, reason: 'forced with --tier' } : decide(verified.handoff, cfg)
  log.decision = decision
  say(`decide   ${decision.tier} (${cfg.tiers[decision.tier]?.engine ?? cfg.engine}/${cfg.tiers[decision.tier]?.model}): ${decision.reason}`)
  if (opts.dryRun) return finish('dry_run')

  let tier: string | null = decision.tier
  let previous: PreviousAttempt | null = null
  for (let i = 0; tier && i <= cfg.maxEscalations; i++) {
    const t = cfg.tiers[tier]
    if (!t) break
    const engine = t.engine ?? cfg.engine
    say(`work     ${tier} (${engine}/${t.model})${previous ? ' with previous failure' : ''}`)
    const res = await work(root, task, { engine, model: t.model, effort: t.effort }, profile, verified, cfg, previous)
    const changed = changedFiles(root)
    const planned = plannedChecks(profile.stack.checks, verified.handoff, changed)
    const checks = planned.length ? runChecks(root, planned, cfg.checkTimeoutMs) : []
    const failed = checks.find(c => c.exit !== 0)
    const attempt: Attempt = {
      tier, engine, model: t.model, costUsd: res.costUsd, tokens: res.tokens, ms: res.ms, workerError: res.error,
      checks, passed: !res.error && !failed && planned.length > 0,
    }
    log.attempts.push(attempt)
    say(`work     ${res.error ? `error: ${res.error.slice(0, 200)}` : 'done'} (${spend(res)}, ${secs(res.ms)}), ${changed.length} file(s) changed`)
    for (const c of checks) say(`check    ${c.exit === 0 ? 'pass' : 'FAIL'} ${c.name}: ${c.command}`)

    if (!planned.length) {
      say('check    no check commands detected; set "checks" in .megaprobe/config.json')
      return finish('no_checks')
    }
    if (attempt.passed) return finish('passed')

    previous = {
      tier,
      diff: spawnSync('git', ['diff', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout ?? '',
      failed: failed ?? { name: 'worker', command: '(worker run)', exit: null, ms: 0, tail: res.error ?? 'worker failed' },
    }
    tier = nextTier(tier, cfg)
    if (tier && i < cfg.maxEscalations) say(`escalate -> ${tier}`)
  }
  return finish('failed')
}

function dirty(root: string): boolean {
  const st = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' })
  return st.status === 0 && st.stdout.trim().length > 0
}

export function changedFiles(root: string): string[] {
  const tracked = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout ?? ''
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).stdout ?? ''
  return [...tracked.split('\n'), ...untracked.split('\n')].filter(f => f && !f.startsWith('.megaprobe/'))
}

export function saveRun(root: string, log: RunLog): void {
  const dir = join(stateDir(root), 'runs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${log.id}.json`), JSON.stringify(log, null, 2))
}

export function loadRuns(root: string): RunLog[] {
  const dir = join(stateDir(root), 'runs')
  let names: string[]
  try { names = readdirSync(dir).filter(n => n.endsWith('.json')).sort() } catch { return [] }
  return names.map(n => JSON.parse(readFileSync(join(dir, n), 'utf8')) as RunLog)
}

export const round = (n: number) => Math.round(n * 10000) / 10000
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`
// Claude reports dollars; Codex only tokens.
const spend = (r: { costUsd: number; tokens: number }) => (r.costUsd ? `$${round(r.costUsd)}` : `${r.tokens} tokens`)
