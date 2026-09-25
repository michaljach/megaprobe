// Claim verification: every handoff claim is checked in code, and failures are removed, not repaired.
// A thinner handoff is fine; a false one sends the worker in the wrong direction.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, relative } from 'node:path'
import type { Checks, Handoff, RemovedClaim, Verified } from './types.ts'

export function verifyHandoff(root: string, handoff: Handoff, checks: Checks, opts: { runRepro?: boolean; timeoutMs?: number } = {}): Verified {
  const removed: RemovedClaim[] = []

  const files = handoff.relevant_files
    .map(f => ({ ...f, path: repoRelative(root, f.path) }))
    .filter(f => {
      const ok = isInside(f.path) && isFile(join(root, f.path))
      if (!ok) removed.push({ claim: `file ${f.path}`, reason: 'does not exist in the repository' })
      return ok
    })

  const contents = files.map(f => readFileSync(join(root, f.path), 'utf8'))
  const symbols = handoff.symbols.filter(sym => {
    const ok = contents.some(c => c.includes(sym)) || gitGrep(root, sym)
    if (!ok) removed.push({ claim: `symbol ${sym}`, reason: 'not found in the repository' })
    return ok
  })

  let repro: Verified['repro'] = null
  let keptRepro = handoff.repro
  if (handoff.repro) {
    const { command, expect } = handoff.repro
    if (!isAllowedCommand(command, checks)) {
      removed.push({ claim: `repro \`${command}\``, reason: 'not one of the project\'s check commands' })
      keptRepro = null
    } else if (opts.runRepro !== false) {
      const run = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', timeout: opts.timeoutMs ?? 120_000 })
      const failed = run.status !== 0
      const matched = expect === 'fails' ? failed : !failed
      repro = { command, exit: run.status, matched }
      if (!matched) {
        removed.push({ claim: `repro \`${command}\` ${expect}`, reason: `it ${failed ? 'fails' : 'passes'} (exit ${run.status})` })
        keptRepro = null
      }
    }
  }

  return { handoff: { ...handoff, relevant_files: files, symbols, repro: keptRepro }, removed, repro }
}

// A repro may only use the project's own check tooling: same leading tokens as a detected check command.
export function isAllowedCommand(command: string, checks: Checks): boolean {
  if (/[;&|`$><]/.test(command)) return false
  const prefixes = Object.values(checks)
    .filter((c): c is string => !!c)
    .map(c => c.replace('{files}', '').trim().split(/\s+/).slice(0, 2).join(' '))
  return prefixes.some(p => command === p || command.startsWith(p + ' '))
}

// Agents often report absolute paths. Keep the claim when it points inside the repo, via any
// spelling of the root (on macOS /tmp and /private/tmp are the same directory).
export function repoRelative(root: string, p: string): string {
  if (!isAbsolute(p)) return normalize(p)
  for (const base of new Set([root, safeRealpath(root)])) {
    const rel = relative(base, p)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel
  }
  return p
}

function safeRealpath(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

function isInside(p: string): boolean {
  return !isAbsolute(p) && !normalize(p).startsWith('..')
}

function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile()
}

function gitGrep(root: string, needle: string): boolean {
  return spawnSync('git', ['grep', '-q', '-F', '--', needle], { cwd: root }).status === 0
}
