# Agents

Tracked seed agents are `alice`, `bob`, and `_template`. Runtime-created agents
(e.g. `carol`, `dave`, etc.) are local state by default: their generated Pi
config, balances, memory, worktrees, and identities are ignored by git.

Use `bun orchestrator/create-agent.ts <name>` to create a local agent from the
template. If you intentionally want a new seed agent in the repository, force-add
its `sandbox/identity.json` (and update this policy if needed); the watcher will
regenerate `.pi-config/` at startup.
