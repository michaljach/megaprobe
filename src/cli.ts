#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { loadConfig } from './config.ts'
import { loadProfile, profileContext } from './profile.ts'
import { loadRuns, round, runPipeline } from './run.ts'

const HELP = `megaprobe: scout first, then spend

Usage:
  megaprobe profile [--refresh] [--no-llm]      detect stack and build the cached project profile
  megaprobe scout "<task>" [--no-llm]           profile + scout + verify + decide, no changes made
  megaprobe run "<task>" [options]              full pipeline: scout, work, check, escalate
  megaprobe log [--json]                        past runs with cost and outcome

Options:
  --engine <name>    claude (default) or codex: which CLI runs the scout, profile and workers
  --tier <name>      skip the decider and start at this tier (fast, standard, strong)
  --allow-dirty      run even with uncommitted changes
  --no-llm           profile from stack detection only (no model pass)
  --json             machine-readable output

Config: .megaprobe/config.json (tiers, rules, budgets, checks). Runs: .megaprobe/runs/.`

async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter(a => a.startsWith('--')))
  const valueOf = (flag: string) => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : undefined)
  const tier = valueOf('--tier')
  const engine = valueOf('--engine') ?? process.env.MEGAPROBE_ENGINE
  if (engine && engine !== 'claude' && engine !== 'codex') {
    console.error(`unknown engine: ${engine} (expected claude or codex)`)
    return 1
  }
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--tier' && argv[i - 1] !== '--engine')
  const [cmd, ...rest] = positional
  const task = rest.join(' ').trim()
  const json = flags.has('--json')

  if (!cmd || flags.has('--help') || cmd === 'help') {
    console.log(HELP)
    return cmd ? 0 : 1
  }

  const root = gitRoot()
  const cfg = loadConfig(root, engine as 'claude' | 'codex' | undefined)
  const llm = flags.has('--no-llm') ? false : undefined
  const say = json ? () => {} : (line: string) => console.error(`[megaprobe] ${line}`)

  switch (cmd) {
    case 'profile': {
      const { profile, cached } = await loadProfile(root, cfg, { refresh: flags.has('--refresh'), llm })
      if (json) console.log(JSON.stringify(profile, null, 2))
      else console.log(`${cached ? '(cached)' : `(built, $${round(profile.costUsd)})`}\n${profileContext(profile)}`)
      return 0
    }
    case 'scout':
    case 'run': {
      if (!task) {
        console.error(`megaprobe ${cmd}: missing task`)
        return 1
      }
      const log = await runPipeline(root, task, cfg, {
        dryRun: cmd === 'scout',
        allowDirty: flags.has('--allow-dirty'),
        llmProfile: llm,
        tier,
        log: say,
      })
      if (json) console.log(JSON.stringify(log, null, 2))
      else if (cmd === 'scout' && log.verified) console.log(JSON.stringify(log.verified.handoff, null, 2))
      else summarize(log)
      return log.outcome === 'passed' || log.outcome === 'dry_run' ? 0 : 1
    }
    case 'log': {
      const runs = loadRuns(root)
      if (json) console.log(JSON.stringify(runs, null, 2))
      else for (const r of runs) {
        const tiers = r.attempts.map(a => a.tier).join('>') || '-'
        console.log(`${r.startedAt.slice(0, 19)}  ${r.outcome.padEnd(12)} $${(r.totalCostUsd ?? 0).toFixed(4).padStart(7)}  ${tiers.padEnd(22)} ${r.task.slice(0, 60)}`)
      }
      return 0
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`)
      return 1
  }
}

function summarize(log: Awaited<ReturnType<typeof runPipeline>>): void {
  const tiers = log.attempts.map(a => `${a.tier}(${a.passed ? 'pass' : 'fail'})`).join(' > ') || 'none'
  // Claude reports dollars; Codex reports only tokens.
  const tokens = log.scout.tokens + log.attempts.reduce((s, a) => s + a.tokens, 0)
  const spend = log.totalCostUsd ? `cost: $${log.totalCostUsd}` : `tokens: ${tokens}`
  console.log(`${log.outcome.toUpperCase()}  attempts: ${tiers}  ${spend}  time: ${(log.totalMs / 1000).toFixed(1)}s`)
}

function gitRoot(): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : process.cwd()
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  err => {
    console.error(`megaprobe: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  },
)
