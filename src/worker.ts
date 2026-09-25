// The worker: a coding agent at the chosen tier, given the verified handoff instead of rediscovering the repo.
import { runAgent } from './agent.ts'
import { profileContext } from './profile.ts'
import { agentPrompt } from './prompts.ts'
import type { AgentResult } from './agent.ts'
import type { CheckResult, Config, Engine, Profile, Verified } from './types.ts'

export interface PreviousAttempt {
  tier: string
  diff: string
  failed: CheckResult
}

// Shared by the headless CLI and the in-session PreToolUse hook, so both workers see the same brief.
export function workerBrief(task: string, profile: Profile, verified: Verified, previous: PreviousAttempt | null): string {
  const { handoff, removed } = verified
  const sections = [
    `# Task\n${task}`,
    `# Handoff (verified by megaprobe)\n\`\`\`json\n${JSON.stringify(handoff, null, 2)}\n\`\`\``,
    removed.length ? `Claims removed during verification (do not rely on them): ${removed.map(r => r.claim).join('; ')}` : '',
    `# Project\n${profileContext(profile)}`,
  ]
  if (previous) {
    sections.push(
      `# Previous attempt (${previous.tier} tier) failed ${previous.failed.name}\n` +
      `Its changes are still in the working tree. Fix or redo them.\n` +
      `$ ${previous.failed.command}\n\`\`\`\n${previous.failed.tail}\n\`\`\`\n` +
      `Diff of the previous attempt:\n\`\`\`diff\n${previous.diff.slice(0, 12000)}\n\`\`\``,
    )
  }
  return sections.filter(Boolean).join('\n\n')
}

export function work(
  root: string,
  task: string,
  tier: { engine: Engine; model: string; effort?: string },
  profile: Profile,
  verified: Verified,
  cfg: Config,
  previous: PreviousAttempt | null,
): Promise<AgentResult> {
  const checkCommands = Object.values(profile.stack.checks).filter((c): c is string => !!c)
  return runAgent({
    engine: tier.engine,
    model: tier.model,
    effort: tier.effort,
    cwd: root,
    access: 'write',
    appendSystemPrompt: agentPrompt('worker'),
    allowedCommands: checkCommands.map(c => c.replace('{files}', '').trim()),
    budgetUsd: cfg.worker.budgetUsd,
    prompt: workerBrief(task, profile, verified, previous),
  })
}
