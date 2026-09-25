// The scout: a cheap model with read-only tools that orients on one task and returns a handoff.
import { runAgent } from './agent.ts'
import { profileContext } from './profile.ts'
import { agentPrompt } from './prompts.ts'
import type { AgentResult } from './agent.ts'
import type { Config, Handoff, Profile } from './types.ts'

export const HANDOFF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['task_type', 'difficulty', 'relevant_files', 'symbols', 'repro', 'constraints', 'plan'],
  properties: {
    task_type: { enum: ['bugfix', 'feature', 'refactor', 'test', 'migration', 'question'] },
    difficulty: { enum: ['trivial', 'routine', 'hard'] },
    relevant_files: {
      type: 'array',
      maxItems: 15,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'why'],
        properties: { path: { type: 'string' }, why: { type: 'string' } },
      },
    },
    symbols: { type: 'array', maxItems: 20, items: { type: 'string' } },
    repro: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['command', 'expect'],
          properties: { command: { type: 'string' }, expect: { enum: ['fails', 'passes'] } },
        },
      ],
    },
    constraints: { type: 'array', maxItems: 10, items: { type: 'string' } },
    plan: { type: 'array', maxItems: 8, items: { type: 'string' } },
  },
} as const

export function scoutPrompt(task: string, profile: Profile): string {
  return `# Task\n${task}\n\n# Project\n${profileContext(profile)}`
}

export async function scout(root: string, task: string, profile: Profile, cfg: Config): Promise<{ handoff: Handoff | null; res: AgentResult }> {
  const res = await runAgent({
    engine: cfg.scout.engine ?? cfg.engine,
    model: cfg.scout.model,
    cwd: root,
    access: 'read',
    systemPrompt: agentPrompt('scout'),
    schema: HANDOFF_SCHEMA,
    budgetUsd: cfg.scout.budgetUsd,
    prompt: scoutPrompt(task, profile),
  })
  const handoff = res.ok ? asHandoff(res.structured) : null
  return { handoff, res }
}

// In-session the scout answers in prose ending with a ```json block; take the last parsable one.
export function parseHandoff(text: string): Handoff | null {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1] ?? '')
  const candidates = blocks.length ? blocks.reverse() : [text]
  for (const c of candidates) {
    try {
      const h = asHandoff(JSON.parse(c.trim()))
      if (h) return h
    } catch {}
  }
  return null
}

function asHandoff(v: unknown): Handoff | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.task_type !== 'string' || typeof o.difficulty !== 'string') return null
  return {
    task_type: o.task_type as Handoff['task_type'],
    difficulty: o.difficulty as Handoff['difficulty'],
    relevant_files: Array.isArray(o.relevant_files)
      ? o.relevant_files.filter((f): f is { path: string; why: string } => !!f && typeof f.path === 'string').map(f => ({ path: f.path, why: String(f.why ?? '') }))
      : [],
    symbols: Array.isArray(o.symbols) ? o.symbols.filter((s): s is string => typeof s === 'string') : [],
    repro: o.repro && typeof o.repro === 'object' && typeof (o.repro as { command?: unknown }).command === 'string'
      ? { command: (o.repro as { command: string }).command, expect: (o.repro as { expect?: string }).expect === 'passes' ? 'passes' : 'fails' }
      : null,
    constraints: Array.isArray(o.constraints) ? o.constraints.filter((s): s is string => typeof s === 'string') : [],
    plan: Array.isArray(o.plan) ? o.plan.filter((s): s is string => typeof s === 'string') : [],
  }
}
