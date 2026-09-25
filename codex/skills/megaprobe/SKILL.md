---
name: megaprobe
description: Run a coding task through megaprobe - a cheap scout explores, megaprobe verifies its claims in code, the cheapest fitting worker makes the change, and typecheck/lint/tests decide whether to escalate to a stronger model. Use when the user asks to use megaprobe.
---

# megaprobe

Run the task with the bundled launcher, `scripts/megaprobe.sh` in this skill's directory, from the repository root:

```sh
<skill-dir>/scripts/megaprobe.sh run --engine codex "<the user's task, verbatim>"
```

- It starts its own `codex exec` processes, which need network access. If the sandbox blocks the command, ask for approval to run it outside the sandbox.
- It refuses to run with uncommitted changes. Ask the user to commit or stash, or pass `--allow-dirty` if they agree.
- `scout` instead of `run` shows the verified handoff and the decided tier without changing anything.
- `profile` builds the cached project profile. Suggest it once per repository.

Progress lines go to stderr. The last stdout line is the outcome (PASSED, FAILED, …) with the tiers tried. Report that to the user, together with `git diff --stat`. Don't redo the work yourself unless the user asks.
