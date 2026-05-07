import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import {
  catallaxyRoot,
  createMarketTask,
  loadDemandPlan,
  missingFiles,
  normalizePlan,
  prepareDemandWorktree,
  renderPlanMarkdown,
  saveDemandPlan,
  type DemandPlanRecord,
} from "./task";
import { isCatallaxyInterfaceEnabled } from "./activation";
import { isSafePlanningBash, isWriteTool } from "./safety";
import { colorGalaxySplash, renderGalaxySplash } from "./splash";

const PLANNING_TOOLS = ["read", "bash", "grep", "find", "ls", "catallaxy_finalize_demand_plan"];
const APPROVED_TOOLS = [
  "read", "bash", "grep", "find", "ls", "write", "edit",
  "catallaxy_finalize_demand_plan", "catallaxy_launch_demand",
];

const demandSystem = `You are the Catallaxy buyer-interface agent.

Your job is to turn a user's fuzzy demand into a test-first Catallaxy market task.

Flow:
1. Clarify the demand with the user until acceptance behavior is precise. Ask short targeted questions; do not over-plan before ambiguities are resolved.
2. Create a test-first plan. The plan is NOT an implementation plan. It must specify:
   - the exact user-visible goal
   - files/tests you will write before auction
   - deterministic commands the reviewer must run
   - a reviewer prompt/acceptance rubric
   - an implementation prompt for Catallaxy agents
   - reservation/review fee/deadline economics
3. Call catallaxy_finalize_demand_plan. This shows the plan to the user for approval. If the user rejects it, refine the plan; do not write files.
4. After approval, Catallaxy creates an isolated git worktree from the user's repo. Write only the approved planned files, and write them only inside that worktree. Do not implement the solution unless the user explicitly asked for scaffolding; the Catallaxy agents implement.
5. Call catallaxy_launch_demand only after the planned files exist in the demand worktree. That commits the test-base branch and posts an open market task for the Catallaxy agents.

Important constraints:
- The plan must optimize the reviewer: clear tests + clear reviewer prompt. Avoid vague subjective goals.
- Prefer deterministic checks that exercise only the buyer-written tests.
- Keep implementation prompt concise and task-scoped. Do not leak private reservation.
- If repo/test framework is unclear, inspect files before asking or deciding.
- Before the plan is approved, write/edit are disabled and bash is read-only. Do not try to mutate files before approval.`;

function updateStatus(ctx: ExtensionContext, active: boolean, demandId?: string): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("catallaxy", active ? ctx.ui.theme.fg("accent", `market-demand${demandId ? `:${demandId}` : ""}`) : undefined);
}

const finalizePlanTool = defineTool({
  name: "catallaxy_finalize_demand_plan",
  label: "Finalize Demand Plan",
  description: "Persist a test-first Catallaxy demand plan before writing tests and launching the market task.",
  promptSnippet: "Persist the Catallaxy demand plan once the user's goal and reviewer/test strategy are precise",
  promptGuidelines: [
    "Use catallaxy_finalize_demand_plan before writing demand tests or launching a Catallaxy task.",
    "Do not call catallaxy_launch_demand until all planned testFiles and filesToWrite exist on disk.",
  ],
  parameters: Type.Object({
    demandId: Type.Optional(Type.String({ description: "Stable id; omit to derive from title" })),
    title: Type.String({ description: "Short task title" }),
    goal: Type.String({ description: "Precise user-visible goal" }),
    repo: Type.Optional(Type.String({ description: "Original user repo path; defaults to the repo where bin/catallaxy was launched" })),
    baseBranch: Type.Optional(Type.String({ description: "Base branch; default main" })),
    filesToWrite: Type.Array(Type.String(), { description: "Non-test files/spec fixtures the interface agent will write before launch" }),
    testFiles: Type.Array(Type.String(), { description: "Test files the interface agent will write before launch" }),
    deterministicChecks: Type.Array(Type.String(), { description: "Commands reviewer/Catallaxy agents must run" }),
    reviewerPrompt: Type.String({ description: "Prompt/rubric for reviewer acceptance" }),
    implementationPrompt: Type.String({ description: "Prompt shown to Catallaxy agents; no private reservation" }),
    reservation: Type.Optional(Type.Number({ description: "Private max payment in tokens; default 500000" })),
    reviewFee: Type.Optional(Type.Number({ description: "Review fee in tokens; default 2000" })),
    deadlineMin: Type.Optional(Type.Number({ description: "Auction deadline in minutes; default 7" })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const root = catallaxyRoot(ctx.cwd);
    const plan = normalizePlan(root, params);
    if (!ctx.hasUI) throw new Error("interactive user approval is required before writing the demand plan");

    const approved = await ctx.ui.confirm(
      "Approve Catallaxy demand plan?",
      renderPlanMarkdown(plan),
    );
    if (!approved) {
      return {
        content: [{ type: "text", text: "User rejected the demand plan. Ask what to change, refine the plan, then call catallaxy_finalize_demand_plan again. Do not write files." }],
        details: { plan, approved: false },
        terminate: true,
      };
    }

    const worktreePlan = await prepareDemandWorktree(root, plan);
    await saveDemandPlan(root, worktreePlan);
    return {
      content: [{ type: "text", text: `User approved and saved demand plan ${worktreePlan.demandId}. Write the planned files inside the isolated demand worktree only: ${worktreePlan.repo}\nFiles: ${[...worktreePlan.testFiles, ...worktreePlan.filesToWrite].join(", ")}` }],
      details: { plan: worktreePlan, approved: true },
    };
  },
  renderResult(result, _options, theme) {
    const plan = result.details?.plan as DemandPlanRecord | undefined;
    if (!plan) return new Text(result.content?.[0]?.type === "text" ? result.content[0].text : "", 0, 0);
    return new Text([
      theme.fg("toolTitle", theme.bold(`Demand plan ${plan.demandId}`)),
      theme.fg("text", plan.title),
      theme.fg("muted", `tests: ${plan.testFiles.join(", ")}`),
      theme.fg("muted", `checks: ${plan.deterministicChecks.join(" && ")}`),
    ].join("\n"), 0, 0);
  },
});

const launchDemandTool = defineTool({
  name: "catallaxy_launch_demand",
  label: "Launch Demand",
  description: "Post a finalized demand plan as a Catallaxy market task after all planned tests/files exist.",
  promptSnippet: "Launch the finalized demand as an open Catallaxy task once tests/files exist",
  promptGuidelines: [
    "Use catallaxy_launch_demand only after writing every planned test file and support file.",
    "catallaxy_launch_demand posts the task; do not also run implementation work yourself.",
  ],
  parameters: Type.Object({
    demandId: Type.String({ description: "Demand id previously saved by catallaxy_finalize_demand_plan" }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const root = catallaxyRoot(ctx.cwd);
    const plan = await loadDemandPlan(root, params.demandId);
    const missing = missingFiles(plan.repo, [...plan.testFiles, ...plan.filesToWrite]);
    if (missing.length > 0) throw new Error(`missing planned files: ${missing.join(", ")}`);

    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm(
        "Launch Catallaxy demand?",
        `Post ${plan.title} with ${plan.testFiles.length} test file(s), reservation ${plan.reservation}?`,
      );
      if (!ok) {
        return { content: [{ type: "text", text: "Launch cancelled by user." }], details: { cancelled: true } };
      }
    }

    const launched = await createMarketTask(root, plan);
    return {
      content: [{ type: "text", text: `Launched ${launched.taskId} for demand ${launched.demandId}. Catallaxy watcher will wake agents for bidding if it is running.` }],
      details: { launched, plan },
      terminate: true,
    };
  },
  renderResult(result, _options, theme) {
    const launched = result.details?.launched as { taskId: string; demandId: string } | undefined;
    if (!launched) return new Text(result.content?.[0]?.type === "text" ? result.content[0].text : "", 0, 0);
    return new Text([
      theme.fg("success", theme.bold(`Launched ${launched.taskId}`)),
      theme.fg("muted", `demand: ${launched.demandId}`),
      theme.fg("muted", "Run/attach watcher separately with make watch."),
    ].join("\n"), 0, 0);
  },
});

export default function catallaxyInterface(pi: ExtensionAPI): void {
  if (!isCatallaxyInterfaceEnabled()) return;

  let demandMode = false;
  let planApproved = false;
  let activeDemandId: string | undefined;

  function enterPlanningMode(ctx?: ExtensionContext): void {
    demandMode = true;
    planApproved = false;
    activeDemandId = undefined;
    pi.setActiveTools(PLANNING_TOOLS);
    if (ctx?.hasUI) ctx.ui.setWidget("catallaxy-interface", undefined);
    if (ctx) updateStatus(ctx, true);
  }

  pi.registerTool(finalizePlanTool);
  pi.registerTool(launchDemandTool);

  pi.registerCommand("demand", {
    description: "Start a Catallaxy test-first demand intake flow",
    handler: async (args, ctx) => {
      enterPlanningMode(ctx);
      if (args.trim()) {
        pi.sendUserMessage(`Start Catallaxy demand intake for this request:\n\n${args.trim()}`);
      } else if (ctx.hasUI) {
        ctx.ui.setEditorText("Describe the demand you want Catallaxy agents to implement...");
        ctx.ui.notify("Catallaxy demand mode enabled. Describe the demand, then I will clarify, plan tests, write tests, and launch.", "info");
      }
    },
  });

  pi.registerCommand("demand-off", {
    description: "Leave Catallaxy demand intake mode",
    handler: async (_args, ctx) => {
      demandMode = false;
      planApproved = false;
      activeDemandId = undefined;
      updateStatus(ctx, false);
      ctx.ui.notify("Catallaxy demand mode disabled.", "info");
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    const text = event.text.trim();
    if (!text || text.startsWith("/")) return { action: "continue" as const };
    if (!demandMode) {
      enterPlanningMode(ctx);
      return {
        action: "transform" as const,
        text: `Start Catallaxy demand intake for this request:\n\n${event.text}`,
      };
    }
    return { action: "continue" as const };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (demandMode && planApproved && activeDemandId) {
      const plan = await loadDemandPlan(catallaxyRoot(ctx.cwd), activeDemandId).catch(() => undefined);
      if (isWriteTool(event.toolName)) {
        const rawPath = String((event.input as { path?: unknown }).path ?? "");
        const path = resolve(ctx.cwd, rawPath);
        const plannedPaths = plan ? [...plan.testFiles, ...plan.filesToWrite].map((f) => resolve(plan.repo, f)) : [];
        if (!plan || !plannedPaths.includes(path)) {
          return { block: true, reason: `Catallaxy interface: after approval, writes are allowed only to files listed in the approved plan under ${plan?.repo ?? "(unknown)"}` };
        }
      }
      if (event.toolName === "bash") {
        const command = String((event.input as { command?: unknown }).command ?? "");
        if (!isSafePlanningBash(command) && (!plan || !command.includes(plan.repo))) {
          return { block: true, reason: `Catallaxy interface: mutating/test bash commands must explicitly operate inside the demand worktree: ${plan?.repo ?? "(unknown)"}` };
        }
      }
      return;
    }

    if (isWriteTool(event.toolName)) {
      return { block: true, reason: "Catallaxy interface: user must approve a test-first demand plan before file writes are allowed." };
    }
    if (event.toolName === "catallaxy_launch_demand") {
      return { block: true, reason: "Catallaxy interface: launch is blocked until the user approves the plan and planned files are written." };
    }
    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      if (!isSafePlanningBash(command)) {
        return { block: true, reason: `Catallaxy interface: bash is read-only until the user approves a demand plan. Blocked command: ${command}` };
      }
    }
  });

  pi.on("before_agent_start", async () => {
    if (!demandMode) return;
    return {
      message: {
        customType: "catallaxy-demand-context",
        content: demandSystem,
        display: false,
      },
    };
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName === "catallaxy_finalize_demand_plan" && !event.isError) {
      const approved = event.result.details?.approved === true;
      activeDemandId = event.result.details?.plan?.demandId;
      planApproved = approved;
      if (approved) pi.setActiveTools(APPROVED_TOOLS);
      else pi.setActiveTools(PLANNING_TOOLS);
      updateStatus(ctx, demandMode, activeDemandId);
    }
    if (event.toolName === "catallaxy_launch_demand" && !event.isError && event.result.details?.launched) {
      demandMode = false;
      planApproved = false;
      activeDemandId = undefined;
      updateStatus(ctx, false);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!demandMode) pi.setActiveTools(PLANNING_TOOLS);
    updateStatus(ctx, demandMode, activeDemandId);
    if (ctx.hasUI) {
      ctx.ui.setHeader((tui, theme) => ({
        render(width: number): string[] {
          return colorGalaxySplash(renderGalaxySplash(width, tui.terminal.rows), theme);
        },
        invalidate() {},
      }));
    }
  });
}
