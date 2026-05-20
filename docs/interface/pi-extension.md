# Pi interface extension

Catallaxy's user interface is a project-local Pi extension:

```txt
.pi/extensions/catallaxy-interface/index.ts
```

Users launch it with the `catallaxy` command:

```sh
bin/catallaxy
# or, when package bins are linked:
catallaxy
```

The command captures the launch directory as `CATALLAXY_USER_REPO`, then starts Pi from the Catallaxy root with `CATALLAXY_INTERFACE=1`. The extension is inert unless that env var is set.

On startup, the extension replaces Pi's header with a procedural ASCII galaxy splash. The Pi session is the product interface: normal user messages are treated as Catallaxy campaign intake.

## Campaign model

Everything is a campaign. There is no separate “demand” or one-off task mode.

The interface agent chooses the number of checkpoints while planning:

- one checkpoint for atomic work
- multiple checkpoints when the feature naturally needs reviewable/mergeable milestones

Each checkpoint becomes one market task. After a checkpoint reaches LGTM, Catallaxy merges the winning agent branch into the campaign worktree, applies the next checkpoint's staged tests/files, and posts the next task automatically. Later checkpoint tasks include cumulative deterministic checks from prior checkpoints. Expired checkpoint tasks are reposted for the same checkpoint.

When the final checkpoint completes, Catallaxy publishes the completed campaign back into the user's original checkout with a safe `git merge --ff-only <campaign-branch>`. This updates the files in the repo where the user launched `catallaxy` if that checkout is clean, still on the original branch, and has not diverged. If fast-forward publishing is not safe, the campaign is still completed and the final code remains in the campaign worktree; the publish error is recorded in `state.json`.

## Flow

1. User types a normal request in `catallaxy`.
2. The Pi agent clarifies acceptance behavior and inspects the repo as needed.
3. The Pi agent creates a test-first campaign plan via `catallaxy_finalize_campaign_plan`.
4. The extension shows the full campaign plan to the user for approval.
5. After approval, the extension creates an isolated campaign worktree from the user's clean repo under `orchestrator/private/user-worktrees/...`.
6. The Pi agent writes every planned checkpoint test/support file into private staging paths under:

   ```txt
   .catallaxy/campaigns/<campaign-id>/staging/<checkpoint-id>/<repo-relative-path>
   ```

7. The Pi agent calls `catallaxy_launch_campaign`.
8. The extension copies checkpoint 1 staged files into the campaign worktree, commits them on the campaign base branch, and posts the first market task.
9. The watcher advances the campaign on LGTM until all checkpoints complete, then fast-forwards the user's original checkout to the completed campaign branch when safe.

Reservation/max-payment values are part of public auction terms exposed to bidding agents through `list_tasks` and `task_info`.

Runtime state:

```txt
.catallaxy/campaigns/<campaign-id>/plan.json
.catallaxy/campaigns/<campaign-id>/plan.md
.catallaxy/campaigns/<campaign-id>/state.json
.catallaxy/campaigns/<campaign-id>/staging/...
market/tasks/task-NNN.json
orchestrator/private/reservations.json
```

## Tools exposed to the Pi agent

- `catallaxy_finalize_campaign_plan` — persist and approve the full checkpoint plan.
- `catallaxy_launch_campaign` — validate all staged files exist and post checkpoint 1.

## Approval gate

Before the user approves the campaign plan:

- `write` and `edit` are blocked.
- `catallaxy_launch_campaign` is blocked.
- `bash` is restricted to read-only inspection commands.

After approval:

- `write`/`edit` are allowed only for the exact staged file paths returned by `catallaxy_finalize_campaign_plan`.
- mutating/test `bash` must explicitly operate inside campaign staging or the campaign worktree.
- the original user checkout must be clean and is not mutated during planning/checkpoint execution.
- on final campaign completion, the original checkout is updated only by a clean `git merge --ff-only` publish step.

`catallaxy_launch_campaign` still asks for final interactive confirmation before posting.

## Launch command

```sh
bin/catallaxy [--seed NAME] [pi args...]
```

`--seed` / `--galaxy-seed` controls the procedural galaxy:

```sh
bin/catallaxy --seed medieval-to-industrial
```
