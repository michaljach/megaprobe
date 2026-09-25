// Checks come from the profile: typecheck, lint, then focused tests (or the full suite if none can be focused).
import { spawnSync } from 'node:child_process'
import { isTestFile } from './detect.ts'
import type { CheckResult, Checks, Handoff } from './types.ts'

export function plannedChecks(checks: Checks, handoff: Handoff | null, changed: string[]): { name: string; command: string }[] {
  const out: { name: string; command: string }[] = []
  if (checks.typecheck) out.push({ name: 'typecheck', command: checks.typecheck })
  if (checks.lint) out.push({ name: 'lint', command: checks.lint })

  const tests = [...new Set([...(handoff?.relevant_files.map(f => f.path) ?? []), ...changed].filter(isTestFile))]
  if (checks.focusedTest && tests.length) {
    out.push({ name: 'focused tests', command: checks.focusedTest.replace('{files}', tests.map(quote).join(' ')) })
  } else if (checks.test) {
    out.push({ name: 'tests', command: checks.test })
  }
  return out
}

export function runChecks(root: string, planned: { name: string; command: string }[], timeoutMs: number): CheckResult[] {
  const results: CheckResult[] = []
  for (const { name, command } of planned) {
    const started = Date.now()
    const run = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', timeout: timeoutMs })
    const tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().slice(-3000)
    results.push({ name, command, exit: run.status, ms: Date.now() - started, tail })
    if (run.status !== 0) break
  }
  return results
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
