import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config, Engine } from './types.ts'

const MODELS: Record<Engine, { fast: string; standard: string; strong: string }> = {
  claude: { fast: 'haiku', standard: 'sonnet', strong: 'opus' },
  codex: { fast: 'gpt-5.6-luna', standard: 'gpt-reserve', strong: 'gpt-6-astra' },
}

export function defaults(engine: Engine = 'claude'): Config {
  const m = MODELS[engine]
  return {
    engine,
    tiers: {
      fast: { model: m.fast },
      standard: { model: m.standard },
      strong: { model: m.strong },
    },
    // Escalation walks this order from the decided tier upward.
    order: ['fast', 'standard', 'strong'],
    // First match wins. Cheapest-first by default: the handoff is meant to make small workers enough.
    rules: [
      { task_type: 'question', tier: 'fast' },
      { difficulty: 'hard', tier: 'standard' },
      { tier: 'fast' },
    ],
    maxEscalations: 2,
    scout: { model: m.fast, budgetUsd: 0.5 },
    profile: { model: m.standard, budgetUsd: 1, llm: true },
    worker: { budgetUsd: 3 },
    checks: {},
    checkTimeoutMs: 300_000,
  }
}

export function stateDir(root: string): string {
  return join(root, '.megaprobe')
}

// Precedence: explicit engine argument > config file > "claude". Model defaults follow the engine.
export function loadConfig(root: string, engine?: Engine): Config {
  const file = join(stateDir(root), 'config.json')
  const user = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>) : {}
  const base = defaults(engine ?? user.engine ?? 'claude')
  return {
    ...base,
    ...user,
    engine: base.engine,
    tiers: { ...base.tiers, ...user.tiers },
    scout: { ...base.scout, ...user.scout },
    profile: { ...base.profile, ...user.profile },
    worker: { ...base.worker, ...user.worker },
    checks: { ...base.checks, ...user.checks },
  }
}
