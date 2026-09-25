// Project profile: stack detection plus one model pass that summarizes the repo.
// Cached against a fingerprint of manifests and top-level layout, so it reruns rarely.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runAgent } from './agent.ts'
import { stateDir } from './config.ts'
import { detectStack, listFiles } from './detect.ts'
import { agentPrompt } from './prompts.ts'
import type { Config, Profile } from './types.ts'

export function fingerprint(root: string, files: string[]): string {
  const h = createHash('sha1')
  const top = [...new Set(files.map(f => f.split('/')[0]))].sort()
  h.update(top.join('\n'))
  for (const m of ['package.json', 'tsconfig.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']) {
    if (existsSync(join(root, m))) h.update(readFileSync(join(root, m)))
  }
  return h.digest('hex').slice(0, 16)
}

export function readCachedProfile(root: string): Profile | null {
  const file = join(stateDir(root), 'profile.json')
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Profile) : null
}

export function saveProfile(root: string, profile: Profile): void {
  mkdirSync(stateDir(root), { recursive: true })
  writeFileSync(join(stateDir(root), 'profile.json'), JSON.stringify(profile, null, 2))
  if (profile.summary) writeFileSync(join(stateDir(root), 'profile.md'), profile.summary + '\n')
}

export async function loadProfile(
  root: string,
  cfg: Config,
  opts: { refresh?: boolean; llm?: boolean } = {},
): Promise<{ profile: Profile; cached: boolean }> {
  const file = join(stateDir(root), 'profile.json')
  const files = listFiles(root)
  const fp = fingerprint(root, files)
  const useLlm = opts.llm ?? cfg.profile.llm

  if (!opts.refresh && existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, 'utf8')) as Profile
    if (cached.fingerprint === fp && (cached.summary || !useLlm)) return { profile: cached, cached: true }
  }

  const stack = detectStack(root, files)
  stack.checks = { ...stack.checks, ...cfg.checks }
  let summary: string | null = null
  let costUsd = 0

  if (useLlm) {
    const res = await runAgent({
      engine: cfg.profile.engine ?? cfg.engine,
      model: cfg.profile.model,
      cwd: root,
      access: 'read',
      systemPrompt: agentPrompt('profiler'),
      budgetUsd: cfg.profile.budgetUsd,
      prompt: repoDigest(root, files, stack),
    })
    costUsd = res.costUsd
    if (res.ok && res.text.trim()) summary = res.text.trim()
  }

  const profile: Profile = { fingerprint: fp, stack, summary, createdAt: new Date().toISOString(), costUsd }
  saveProfile(root, profile)
  return { profile, cached: false }
}

// A compressed view of the repo so the profile model starts oriented instead of listing directories.
export function repoDigest(root: string, files: string[], stack: Profile['stack']): string {
  const tree = files.slice(0, 400).join('\n') + (files.length > 400 ? `\n… ${files.length - 400} more files` : '')
  const readme = ['README.md', 'readme.md', 'README'].find(f => existsSync(join(root, f)))
  const readmeText = readme ? readFileSync(join(root, readme), 'utf8').slice(0, 4000) : '(none)'
  return [
    'Write the project profile for this repository.',
    `## Detected stack\n${JSON.stringify(stack, null, 2)}`,
    `## Files (${files.length})\n${tree}`,
    `## README (truncated)\n${readmeText}`,
  ].join('\n\n')
}

export function profileContext(profile: Profile): string {
  const s = profile.stack
  const langs = Object.entries(s.languages).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} (${n})`).join(', ')
  return [
    `Stack: ${langs || 'unknown'}; frameworks: ${s.frameworks.join(', ') || 'none detected'}; package manager: ${s.packageManager ?? 'n/a'}.`,
    `Checks: ${Object.entries(s.checks).filter(([, v]) => v).map(([k, v]) => `${k}=\`${v}\``).join(', ') || 'none'}.`,
    profile.summary ? `\n${profile.summary}` : '',
  ].join('\n')
}
