export type Engine = 'claude' | 'codex'
export type Difficulty = 'trivial' | 'routine' | 'hard'
export type TaskType = 'bugfix' | 'feature' | 'refactor' | 'test' | 'migration' | 'question'

export interface Checks {
  typecheck: string | null
  lint: string | null
  test: string | null
  // Test command with a {files} placeholder, used when the handoff names test files.
  focusedTest: string | null
}

export interface Stack {
  languages: Record<string, number>
  frameworks: string[]
  packageManager: string | null
  manifests: string[]
  checks: Checks
}

export interface Profile {
  fingerprint: string
  stack: Stack
  summary: string | null
  createdAt: string
  costUsd: number
}

export interface Handoff {
  task_type: TaskType
  difficulty: Difficulty
  relevant_files: { path: string; why: string }[]
  symbols: string[]
  repro: { command: string; expect: 'fails' | 'passes' } | null
  constraints: string[]
  plan: string[]
}

export interface RemovedClaim {
  claim: string
  reason: string
}

export interface Verified {
  handoff: Handoff
  removed: RemovedClaim[]
  repro: { command: string; exit: number | null; matched: boolean } | null
}

export interface Tier {
  engine?: Engine
  model: string
  effort?: string
}

export interface Rule {
  task_type?: TaskType
  difficulty?: Difficulty
  tier: string
}

export interface Config {
  // Default engine for every stage; a tier, the scout or the profile can override it.
  engine: Engine
  tiers: Record<string, Tier>
  order: string[]
  rules: Rule[]
  maxEscalations: number
  scout: { engine?: Engine; model: string; budgetUsd: number }
  profile: { engine?: Engine; model: string; budgetUsd: number; llm: boolean }
  worker: { budgetUsd: number }
  checks: Partial<Checks>
  checkTimeoutMs: number
}

export interface CheckResult {
  name: string
  command: string
  exit: number | null
  ms: number
  tail: string
}

export interface Attempt {
  tier: string
  engine: Engine
  model: string
  costUsd: number
  tokens: number
  ms: number
  workerError: string | null
  checks: CheckResult[]
  passed: boolean
}

export interface RunLog {
  id: string
  task: string
  startedAt: string
  profileCached: boolean
  scout: { engine: Engine; model: string; costUsd: number; tokens: number; ms: number; error: string | null }
  verified: Verified | null
  decision: { tier: string; reason: string } | null
  attempts: Attempt[]
  outcome: 'passed' | 'failed' | 'scout_failed' | 'no_checks' | 'dry_run'
  totalCostUsd: number
  totalMs: number
}
