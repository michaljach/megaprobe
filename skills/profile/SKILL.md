---
name: profile
description: Build or refresh the megaprobe project profile (architecture, conventions, layout, pitfalls) that every megaprobe scout and worker reads. Use when the user invokes /megaprobe:profile or megaprobe reports that no profile exists.
---

Build the megaprobe project profile.

Call the Agent tool with `subagent_type: "megaprobe:profiler"` and the prompt `Write the project profile.` megaprobe gives the profiler a digest of the repository and saves its answer to `.megaprobe/profile.md` by itself, so you don't write any files.

When it finishes, tell the user the profile was saved and summarize it in two or three lines.
