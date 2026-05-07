# Pi interface extension

Catallaxy's user interface starts as a project-local Pi extension:

```txt
.pi/extensions/catallaxy-interface/index.ts
```

Users launch it with the `catallaxy` command:

```sh
bin/catallaxy
# or, when package bins are linked:
catallaxy
```

The command captures the directory it was launched from as `CATALLAXY_USER_REPO`, then starts Pi from the Catallaxy root with `CATALLAXY_INTERFACE=1`. The project-local extension is inert unless that env var is set, so normal `pi` sessions in this repo are not forced into the Catallaxy intake flow.

On startup, the extension replaces Pi's header with a procedural ASCII galaxy splash. It computes the current terminal center, places `catallaxy` there as plain text, and derives the star field from a seed.

The Pi session is the interface: the user chats with a buyer-interface agent until the demand is precise, then the extension creates an isolated git worktree of the user's repo, the agent writes tests/spec files there, and the extension posts a market task for Catallaxy implementation agents.

When launched through `catallaxy`, users can type a demand directly; the extension routes normal input into demand intake. Direct file writes are locked until the user approves the test-first plan.

## Flow

1. User starts intake either by typing normally:

   ```txt
   build X
   ```

   or explicitly:

   ```txt
   /demand build X
   ```

2. The Pi agent asks clarifying questions until acceptance behavior is precise.
3. The Pi agent creates a test-first demand plan via `catallaxy_finalize_demand_plan`.
4. The extension shows the plan to the user for approval.
5. Only after approval, the extension creates a clean git worktree from the user's repo under `orchestrator/private/user-worktrees/...`.
6. The Pi agent writes the planned test files and supporting spec/fixture files inside that isolated worktree, not the user's original checkout.
7. The Pi agent calls `catallaxy_launch_demand`.
8. The extension commits the tests on the demand base branch, then writes Catallaxy market state relative to the Catallaxy root:

   ```txt
   .catallaxy/demands/<demand-id>/plan.json
   .catallaxy/demands/<demand-id>/plan.md
   market/tasks/task-NNN.json
   orchestrator/private/reservations.json
   ```

9. The normal Catallaxy watcher wakes implementation agents to bid/work. Agents clone the demand worktree and diff against the committed test-base branch.

## Why test-first

The interface does not ask Catallaxy agents to infer what the user meant. It turns the user's demand into:

- deterministic tests/checks
- explicit reviewer prompt/rubric
- concise implementation prompt
- private reservation economics

This keeps the market task objective enough for autonomous settlement while preserving the user's intent.

## Launch command

```sh
bin/catallaxy [--seed NAME] [pi args...]
```

This is intentionally a thin Pi launcher, not a replacement for the market/orchestrator commands. It records the current directory as the user repo, sets `CATALLAXY_INTERFACE=1`, changes cwd to the Catallaxy root, pre-paints the galaxy splash immediately, then execs `pi` with extension discovery disabled except for the Catallaxy interface extension.

`--seed` / `--galaxy-seed` controls the procedural galaxy:

```sh
bin/catallaxy --seed medieval-to-industrial
```

## Pi commands

```txt
/demand <initial demand>  Explicitly start buyer intake mode
/demand-off              Leave buyer intake mode
```

When launched through `catallaxy`, normal non-command input automatically starts buyer intake mode.

## Tools exposed to the Pi agent

- `catallaxy_finalize_demand_plan` — persist the test-first plan.
- `catallaxy_launch_demand` — validate planned files exist and post the market task.

## Approval gate

Before the user approves the plan — including before `/demand` has explicitly been used:

- `write` and `edit` are blocked.
- `catallaxy_launch_demand` is blocked.
- `bash` is restricted to read-only inspection commands.
- normal user input is transformed into Catallaxy demand intake.
- `catallaxy_finalize_demand_plan` asks for user approval before writing `.catallaxy/demands/<id>/plan.*`.

After approval, write/edit and launch tools become available for the test-writing phase, but writes are allowed only inside the demand worktree. The original user checkout must be clean and is not mutated by the interface.

`catallaxy_launch_demand` still asks for user confirmation in interactive Pi before posting.
