import type { Config, Handoff } from './types.ts'

// Rules over the verified handoff: first match wins. Stack is context, never the question.
export function decide(handoff: Handoff, cfg: Config): { tier: string; reason: string } {
  for (const rule of cfg.rules) {
    if (rule.task_type && rule.task_type !== handoff.task_type) continue
    if (rule.difficulty && rule.difficulty !== handoff.difficulty) continue
    if (!cfg.tiers[rule.tier]) continue
    const when = [rule.task_type, rule.difficulty].filter(Boolean).join(' + ') || 'default'
    return { tier: rule.tier, reason: `rule ${when} -> ${rule.tier}` }
  }
  const first = cfg.order[0] ?? Object.keys(cfg.tiers)[0] ?? 'fast'
  return { tier: first, reason: 'no rule matched' }
}

export function nextTier(current: string, cfg: Config): string | null {
  const i = cfg.order.indexOf(current)
  return i >= 0 && i + 1 < cfg.order.length ? cfg.order[i + 1] ?? null : null
}
