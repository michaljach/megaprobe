import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const BROKEN = 'export const add = (a, b) => a - b\n'
export const FIXED = 'export const add = (a, b) => a + b\n'

// A small committed repo: add() is broken and its test fails until it is fixed.
export function makeRepo(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'megaprobe-test-'))
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node test/math.test.mjs' }, dependencies: { react: '^19.0.0' } }),
    'src/math.js': BROKEN,
    'src/greet.js': 'export const hi = () => "hi"\n',
    'test/math.test.mjs': 'import { add } from "../src/math.js"\nif (add(1, 2) !== 3) { console.error("add broken"); process.exit(1) }\n',
    'README.md': '# demo\n',
    ...extra,
  }
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), c)
  }
  const git = (...a: string[]) => spawnSync('git', a, { cwd: root })
  git('init', '-q')
  git('add', '-A')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  return root
}

export const HANDOFF = {
  task_type: 'bugfix',
  difficulty: 'routine',
  relevant_files: [
    { path: 'src/math.js', why: 'defines add' },
    { path: 'src/nope.js', why: 'invented by the scout' },
  ],
  symbols: ['add', 'subtractEverything'],
  repro: { command: 'npm run test', expect: 'fails' },
  constraints: ['keep the export name'],
  plan: ['fix the operator in add'],
}
