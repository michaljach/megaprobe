// Stack detection from files only. No model: the stack is a fact, not a judgment.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { Checks, Stack } from './types.ts'

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.swift': 'swift', '.rb': 'ruby', '.php': 'php', '.cs': 'csharp', '.c': 'c', '.cpp': 'cpp',
  '.vue': 'vue', '.svelte': 'svelte', '.css': 'css', '.scss': 'css',
}

const FRAMEWORK_DEPS: Record<string, string> = {
  react: 'react', next: 'next', vue: 'vue', svelte: 'svelte', '@angular/core': 'angular',
  'react-native': 'react-native', expo: 'expo', express: 'express', fastify: 'fastify', hono: 'hono',
  '@nestjs/core': 'nestjs', vite: 'vite', tailwindcss: 'tailwind', prisma: 'prisma',
  'drizzle-orm': 'drizzle', vitest: 'vitest', jest: 'jest', '@playwright/test': 'playwright',
  eslint: 'eslint', '@biomejs/biome': 'biome', typescript: 'typescript',
}

const MANIFESTS = [
  'package.json', 'tsconfig.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'package-lock.json',
  'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'Gemfile', 'composer.json', 'Package.swift',
]

export function listFiles(root: string): string[] {
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  if (git.status === 0) return git.stdout.split('\n').filter(Boolean)
  return (readdirSync(root, { recursive: true }) as string[])
    .filter(f => !/(^|\/)(node_modules|\.git|dist|build)(\/|$)/.test(f))
}

export function detectStack(root: string, files = listFiles(root)): Stack {
  const languages: Record<string, number> = {}
  for (const f of files) {
    const lang = LANGUAGE_BY_EXT[extname(f)]
    if (lang) languages[lang] = (languages[lang] ?? 0) + 1
  }
  const manifests = MANIFESTS.filter(m => existsSync(join(root, m)))
  const frameworks = new Set<string>()
  const checks: Checks = { typecheck: null, lint: null, test: null, focusedTest: null }
  let packageManager: string | null = null

  if (manifests.includes('package.json')) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string>
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    for (const [dep, name] of Object.entries(FRAMEWORK_DEPS)) if (deps[dep]) frameworks.add(name)

    packageManager = manifests.includes('pnpm-lock.yaml') ? 'pnpm'
      : manifests.includes('yarn.lock') ? 'yarn'
      : manifests.some(m => m.startsWith('bun.')) ? 'bun'
      : 'npm'
    const run = (script: string) => `${packageManager} run ${script}`
    const exec = packageManager === 'npm' ? 'npx' : packageManager === 'bun' ? 'bunx' : `${packageManager} exec`
    const scripts = pkg.scripts ?? {}

    checks.typecheck = scripts.typecheck ? run('typecheck')
      : manifests.includes('tsconfig.json') ? `${exec} tsc --noEmit` : null
    checks.lint = scripts.lint ? run('lint') : null
    checks.test = scripts.test && !/no test specified/.test(scripts.test) ? run('test') : null
    checks.focusedTest = frameworks.has('vitest') ? `${exec} vitest run {files}`
      : frameworks.has('jest') ? `${exec} jest {files}`
      : null
  } else if (manifests.some(m => ['pyproject.toml', 'requirements.txt', 'setup.py'].includes(m))) {
    packageManager = existsSync(join(root, 'uv.lock')) ? 'uv' : 'pip'
    const text = manifests.includes('pyproject.toml') ? readFileSync(join(root, 'pyproject.toml'), 'utf8') : ''
    if (/mypy/.test(text)) checks.typecheck = 'mypy .'
    if (/ruff/.test(text)) checks.lint = 'ruff check .'
    checks.test = 'pytest -q'
    checks.focusedTest = 'pytest -q {files}'
    for (const fw of ['django', 'fastapi', 'flask', 'pytest']) if (text.includes(fw)) frameworks.add(fw)
  } else if (manifests.includes('go.mod')) {
    packageManager = 'go'
    checks.typecheck = 'go build ./...'
    checks.lint = 'go vet ./...'
    checks.test = 'go test ./...'
  } else if (manifests.includes('Cargo.toml')) {
    packageManager = 'cargo'
    checks.typecheck = 'cargo check'
    checks.lint = 'cargo clippy -- -D warnings'
    checks.test = 'cargo test'
  }

  return { languages, frameworks: [...frameworks].sort(), packageManager, manifests, checks }
}

export function isTestFile(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.go$/i.test(path)
}
