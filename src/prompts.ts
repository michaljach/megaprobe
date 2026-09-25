// The agent definitions in agents/*.md are the single source for prompts: the Claude Code plugin
// loads them as subagents, and the headless CLI reads the same bodies as system prompts.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const AGENTS_DIR = fileURLToPath(new URL('../agents/', import.meta.url))

export function agentPrompt(name: 'scout' | 'worker' | 'profiler'): string {
  const raw = readFileSync(AGENTS_DIR + `${name}.md`, 'utf8')
  return raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
}
