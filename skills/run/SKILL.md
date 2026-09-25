---
name: run
description: Make a code change through megaprobe - a cheap scout explores and returns a handoff, megaprobe verifies it in code, the cheapest fitting worker makes the change, and checks decide whether to escalate. Use for requests to change code in this repository (fix a bug, add or change a feature, refactor, rename, migrate, write tests), unless the user asks you to do it directly or it is a one-line edit that needs no exploration. Not for questions or discussion.
argument-hint: <task>
---

Run this task through the megaprobe pipeline: $ARGUMENTS

You are the orchestrator. Keep your own context small: do not explore the repository or edit files yourself unless a step below says so.

1. Call the Agent tool with `subagent_type: "megaprobe:scout"` and the task, word for word, as the prompt.
2. megaprobe verifies the scout's handoff and adds a note to the result: what it kept, what it removed, and the decided tier.
   - For a question, answer from the handoff and stop.
   - Otherwise call the Agent tool with `subagent_type: "megaprobe:worker"` and the same task as the prompt. megaprobe sets the worker's model and gives it the verified handoff. Don't set `model` yourself.
3. After each worker run, megaprobe runs typecheck, lint and focused tests and tells you what to do next:
   - checks passed: review `git diff` briefly for scope and quality, then report to the user.
   - escalated: call `megaprobe:worker` again with the same task. It gets the failure output and the previous diff.
   - still failing after the last tier: stop and report the failure to the user.
4. In your final report, mention which tier did the work and whether any scout claims were removed.
