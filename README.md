# megaprobe

**Scout first, then spend.** A staged model pipeline for coding agents:

1. **Detect** the stack from manifests. No model involved.
2. **Profile** the repo once with a stronger model, cached.
3. **Scout** each task with a cheap read-only model that returns a structured handoff: relevant files, symbols, repro command, constraints, plan.
4. **Verify** the handoff's claims in code and remove the false ones.
5. **Decide** which worker tier fits the task (rules first, pluggable later).
6. **Work** with the cheapest fitting worker.
7. **Check** with typecheck, lint and focused tests, and escalate one tier on failure.

## How it works

```
 Repo ──► Detect stack          code, no model
             │
             ▼
          Project profile       big-context model, cached once per repo
             │
 Task ──► Scout                 cheap model, read-only tools
             │
             ▼
          Handoff               files, symbols, repro, plan
             │
             ▼
          Verify claims         code: false claims removed
             │
             ▼
          Decide tier           rules
             │
             ▼
    ┌───► Worker                fast → standard → strong
    │        │
    │        ▼
    │     Check                 typecheck, lint, tests ── pass ──► Done
    │        │ fail
    └────────┘ escalate one tier, with the failure output
```

Why this order: recent results show a verified repository handoff lets cheap models match the best single model at about ⅕ of the cost, and the handoff mattered more than choosing the model. See [the paper](docs/PAPER.md).

## Two ways to run it

### 1. Inside Claude Code (plugin)

You keep using Claude Code as usual. Your session model orchestrates, megaprobe's subagents do the exploring and the editing, and megaprobe's hooks make the deterministic decisions.

```
/plugin marketplace add michaljach/megaprobe
/plugin install megaprobe@megaprobe
```

Then just work as usual ([how it works, with diagrams](docs/IN-SESSION.md)). A change request like *"add(1, 2) returns -1, can you fix it?"* goes through megaprobe automatically. No command is needed.

```
/megaprobe:profile                                  # once per repo: architecture, conventions, pitfalls
/megaprobe:run add(1, 2) returns -1, fix it         # optional: force the pipeline explicitly
```

**Automatic mode** (`"auto"` in the config):
- `smart` (default): a `UserPromptSubmit` hook checks in code, with no model call, whether the prompt looks like a request to change code. If it does, the hook adds a one-line hint to use the `megaprobe:run` skill. Your session model still decides, so a question or a trivial one-line edit is handled normally.
- `always`: hint on every prompt.
- `off`: only `/megaprobe:run`.

Slash commands, `!` shell commands, and prompts containing *"without megaprobe"* are never routed.

| Piece | What it does |
|---|---|
| `megaprobe:scout` subagent | Haiku, read-only tools. Returns the handoff as a JSON block |
| `megaprobe:worker` subagent | Makes the change. Its model is set per run by the hook, not by the orchestrator |
| `megaprobe:profiler` subagent | Writes the project profile. The hook saves it, so it needs no write access |
| `SessionStart` hook | Detects the stack and loads the cached profile into the session |
| `UserPromptSubmit` hook | Automatic mode: adds the hint to use megaprobe when a prompt looks like a code change |
| `PreToolUse` hook on `Agent` | Adds project context to the scout's prompt. For the worker, sets `model` to the decided tier and replaces its prompt with the verified handoff (plus the previous failure on escalation). Refuses to start a worker before a scout has run |
| `SubagentStop` hook | Parses the scout's handoff, verifies every claim (files exist, symbols found, repro command behaves as claimed) and applies the tier rules |
| `PostToolUse` hook on `Agent` | After the scout: reports what was kept and removed, and the tier. After the worker: runs the checks, then tells the orchestrator to finish, call the worker again one tier up, or stop and report |

Worker subagents use your session's normal permission prompts. No permissions are bypassed.

### 2. Headless CLI (Claude Code or Codex as the engine)

```sh
npx megaprobe profile
npx megaprobe scout "add(1, 2) returns -1, fix it"          # handoff + decided tier, no changes
npx megaprobe run   "add(1, 2) returns -1, fix it"          # engine: claude -p
npx megaprobe run --engine codex "add(1, 2) returns -1…"    # engine: codex exec
npx megaprobe log
```

This runs `claude -p` or `codex exec` with lean flags: no user plugins, MCP servers or user settings. With those loaded, a trivial Haiku call measured about 16× more expensive. Workers may edit files and run only the project's own check commands. It refuses to run with uncommitted changes unless you pass `--allow-dirty`.

**Codex plugin:** `.codex-plugin/plugin.json` ships a `megaprobe` skill that calls this CLI with `--engine codex`.

## Config

Optional `.megaprobe/config.json`:

```json
{
  "engine": "claude",
  "tiers": { "fast": { "model": "haiku" }, "standard": { "model": "sonnet" }, "strong": { "model": "opus" } },
  "rules": [
    { "task_type": "question", "tier": "fast" },
    { "difficulty": "hard", "tier": "standard" },
    { "tier": "fast" }
  ],
  "maxEscalations": 2,
  "auto": "smart",
  "checks": { "test": "pnpm vitest run", "focusedTest": "pnpm vitest run {files}" }
}
```

Codex defaults: `gpt-5.6-luna` / `gpt-reserve` / `gpt-6-astra`. State lives in `.megaprobe/` (profile, sessions, runs), so add it to `.gitignore`.

## Status

v0.1 proof of concept.

- **Offline tests:** `npm test` runs 15 tests using fake `claude` and `codex` binaries, including a full escalation and the automatic-mode rules.
- **Live, Claude Code plugin:** with `/megaprobe:run`, one run on a toy repo fixed the bug on the Haiku tier with nothing escalated, for $0.09 in total (Sonnet orchestrator $0.057, Haiku scout and worker $0.033). A plain prompt with no command went through the same pipeline automatically, for $0.16.
- **Live, headless CLI with the real Codex:** one run passed on `gpt-5.6-luna` in 40s.
- **Not yet done:** the evaluation on real repositories. See [the paper](docs/PAPER.md) §5.

## Develop

```sh
npm install
npm test            # node --test, no model calls
npm run typecheck
node src/cli.ts --help
claude --plugin-dir .   # load the plugin from this checkout
MEGAPROBE_DEBUG=/tmp/megaprobe-hooks.jsonl claude --plugin-dir .   # log every hook input/output
```

Node ≥ 22.18. The source is TypeScript that Node runs directly, and `npm run build` emits `dist/` for the npm package.
