---
name: buddy-experiment-code
description: Create and edit isolated, reproducible experiment code.
---

Read existing experiments before creating one. experiment_create requires an idempotency request_id, title and optional parent_id; it returns a private Git branch/worktree inside the project. Edit only that returned worktree. Explicitly set cwd for all commands; your native session may still start in the original project root. Do not change or commit the user's original checkout.

Inspect parent code, implement the one hypothesis, check the diff and commit your changes in the experiment worktree. Keep dependencies and configuration versioned. Do not launch training in the shell. run_prepare accepts only a clean committed snapshot; the root project's HEAD need not change. If an experiment already produced an answer, create a child rather than editing it. A repair that answered nothing may use a new commit on the same branch and a new Run.
