import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import {
  campaignDir,
  campaignStagedFiles,
  campaignStagingDir,
  catallaxyRoot,
  launchCampaign,
  loadCampaignPlan,
  missingStagedFiles,
  normalizeCampaignPlan,
  prepareCampaignWorktree,
  renderCampaignPlanMarkdown,
  saveCampaignPlan,
  type CampaignPlanRecord,
} from "./task";
import { isCatallaxyInterfaceEnabled } from "./activation";
import { isSafePlanningBash, isWriteTool } from "./safety";
import { colorGalaxySplash, renderGalaxySplash } from "./splash";

// Keep the full campaign tool surface visible from the first turn.
// Pi builds the provider tool list at turn boundaries; hiding write/edit/launch
// during planning can leave the post-approval continuation unable to stage files
// or launch. Safety is enforced in the tool_call gate below instead.
const CAMPAIGN_TOOLS = [
  "read", "bash", "grep", "find", "ls", "write", "edit",
  "catallaxy_finalize_campaign_plan", "catallaxy_launch_campaign",
];
const PLANNING_TOOLS = CAMPAIGN_TOOLS;
const APPROVED_TOOLS = CAMPAIGN_TOOLS;

const campaignSystem = `You are the Catallaxy interface agent.

The user launched the \`catallaxy\` product. Every normal request is a Catallaxy campaign intake: turn the user's fuzzy goal into a test-first campaign, choose the checkpoint count, get approval, stage tests/spec files, and launch the market.

Flow:
1. Clarify the goal until acceptance behavior is precise. Ask short targeted questions; inspect the repo when useful before asking.
2. Create a campaign plan. You choose the fewest checkpoints that keep each checkpoint independently testable, reviewable, and mergeable. Use one checkpoint for atomic work; split only when acceptance naturally ratchets through milestones.
3. Each checkpoint plan is NOT an implementation plan. It must specify:
   - checkpoint goal and user-visible acceptance behavior
   - repo-relative test/support files you will write before launch
   - deterministic commands the reviewer must run for that checkpoint
   - reviewer prompt/rubric
   - implementation prompt shown to Catallaxy agents
   - reservation/review fee economics (auction deadline is fixed at 6 minutes)
4. Call catallaxy_finalize_campaign_plan. This shows the full campaign plan to the user for approval. If rejected, refine the plan; do not write files.
5. After approval, write every planned checkpoint test/support file into the private staging paths returned by the tool. Preserve the repo-relative path under each checkpoint's staging directory. Do not implement the product code.
6. Call catallaxy_launch_campaign only after all staged files exist. The launcher copies checkpoint 1 into the campaign worktree, commits it, and posts the first market task. Later checkpoints are posted automatically after LGTM. Later checkpoint tasks automatically include prior deterministic checks too. After the final checkpoint, Catallaxy fast-forwards the user's original checkout to the completed campaign branch when safe.

Important constraints:
- The interface must optimize reviewer clarity: objective tests + explicit reviewer prompt.
- Do not leak private reservation logic in implementation prompts beyond the chosen public task terms.
- Before approval, write/edit/launch are blocked by the interface and bash is read-only. Do not try to mutate files before approval.
- After approval, write only the staged files returned by catallaxy_finalize_campaign_plan. The original user checkout is never mutated by the interface.`;

function updateStatus(ctx: ExtensionContext, active: boolean, campaignId?: string): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("catallaxy", active ? ctx.ui.theme.fg("accent", `campaign${campaignId ? `:${campaignId}` : ""}`) : undefined);
}

function stageInstructions(root: string, plan: CampaignPlanRecord): string {
  const lines: string[] = [];
  lines.push(`Campaign staging root: ${campaignStagingDir(root, plan.campaignId)}`);
  for (const entry of campaignStagedFiles(root, plan)) {
    lines.push(`- checkpoint ${entry.checkpoint.index + 1} (${entry.checkpoint.id}) ${entry.targetPath}`);
    lines.push(`  write: ${entry.stagedPath}`);
  }
  return lines.join("\n");
}

function installGalaxyHeader(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setHeader((tui, theme) => ({
    render(width: number): string[] {
      return colorGalaxySplash(renderGalaxySplash(width, tui.terminal.rows), theme);
    },
    invalidate() {},
  }));
}

function installEmptyHeader(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setHeader(() => ({
    render(): string[] { return []; },
    invalidate() {},
  }));
}

async function withPlainHeader<T>(ctx: ExtensionContext, fn: () => Promise<T>): Promise<T> {
  if (!ctx.hasUI) return await fn();
  installEmptyHeader(ctx);
  try {
    return await fn();
  } finally {
    installGalaxyHeader(ctx);
  }
}

const checkpointSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Stable checkpoint id; omit to derive from title" })),
  title: Type.String({ description: "Short checkpoint title" }),
  goal: Type.String({ description: "Precise user-visible goal for this checkpoint" }),
  filesToWrite: Type.Array(Type.String(), { description: "Repo-relative non-test support/fixture/spec files staged for this checkpoint" }),
  testFiles: Type.Array(Type.String(), { description: "Repo-relative test files staged for this checkpoint" }),
  deterministicChecks: Type.Array(Type.String(), { description: "Commands reviewer/Catallaxy agents must run for this checkpoint" }),
  reviewerPrompt: Type.String({ description: "Prompt/rubric for reviewer acceptance for this checkpoint" }),
  implementationPrompt: Type.String({ description: "Prompt shown to Catallaxy agents for this checkpoint; no private reservation reasoning" }),
  reservation: Type.Optional(Type.Number({ description: "Private max payment in tokens; default campaign reservation or 500000" })),
  reviewFee: Type.Optional(Type.Number({ description: "Review fee in tokens; default campaign reviewFee or 2000" })),
});

const finalizeCampaignTool = defineTool({
  name: "catallaxy_finalize_campaign_plan",
  label: "Finalize Campaign Plan",
  description: "Persist a test-first Catallaxy campaign plan. The planner chooses how many checkpoints the campaign needs.",
  promptSnippet: "Persist the Catallaxy campaign plan once goals, checkpoints, tests, reviewer strategy, and economics are precise",
  promptGuidelines: [
    "Use catallaxy_finalize_campaign_plan before writing any campaign tests or launching a Catallaxy campaign.",
    "Use the fewest checkpoints that keep each checkpoint independently testable, reviewable, and mergeable.",
    "Do not call catallaxy_launch_campaign until all staged files returned by catallaxy_finalize_campaign_plan exist on disk.",
  ],
  parameters: Type.Object({
    campaignId: Type.Optional(Type.String({ description: "Stable id; omit to derive from title" })),
    title: Type.String({ description: "Short campaign title" }),
    goal: Type.String({ description: "Precise overall user-visible campaign goal" }),
    repo: Type.Optional(Type.String({ description: "Original user repo path; defaults to the repo where catallaxy was launched" })),
    baseBranch: Type.Optional(Type.String({ description: "Campaign base branch; default catallaxy/campaign/<id>/base" })),
    checkpoints: Type.Array(checkpointSchema, { description: "Ordered checkpoints. One checkpoint is valid for atomic work." }),
    reservation: Type.Optional(Type.Number({ description: "Default private max payment per checkpoint in tokens; default 500000" })),
    reviewFee: Type.Optional(Type.Number({ description: "Default review fee per checkpoint in tokens; default 2000" })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const root = catallaxyRoot(ctx.cwd);
    const plan = normalizeCampaignPlan(root, params);
    if (!ctx.hasUI) throw new Error("interactive user approval is required before writing the campaign plan");

    const approved = await withPlainHeader(ctx, () => ctx.ui.confirm(
      "Approve Catallaxy campaign plan?",
      renderCampaignPlanMarkdown(plan),
    ));
    if (!approved) {
      return {
        content: [{ type: "text", text: "User rejected the campaign plan. Ask what to change, refine the plan, then call catallaxy_finalize_campaign_plan again. Do not write files." }],
        details: { plan, approved: false },
        terminate: true,
      };
    }

    const worktreePlan = await prepareCampaignWorktree(root, plan);
    await saveCampaignPlan(root, worktreePlan);
    return {
      content: [{
        type: "text",
        text: `User approved and saved campaign ${worktreePlan.campaignId}. Write every planned file to its private staging path, not to the original repo and not directly to the campaign worktree.\n${stageInstructions(root, worktreePlan)}`,
      }],
      details: { plan: worktreePlan, approved: true, staging: campaignStagedFiles(root, worktreePlan) },
    };
  },
  renderResult(result, _options, theme) {
    const plan = result.details?.plan as CampaignPlanRecord | undefined;
    if (!plan) return new Text(result.content?.[0]?.type === "text" ? result.content[0].text : "", 0, 0);
    return new Text([
      theme.fg("toolTitle", theme.bold(`Campaign plan ${plan.campaignId}`)),
      theme.fg("text", plan.title),
      theme.fg("muted", `checkpoints: ${plan.checkpoints.length}`),
      ...plan.checkpoints.map((c) => theme.fg("muted", `${c.index + 1}. ${c.title} — tests: ${c.testFiles.join(", ")}`)),
    ].join("\n"), 0, 0);
  },
});

const launchCampaignTool = defineTool({
  name: "catallaxy_launch_campaign",
  label: "Launch Campaign",
  description: "Launch a finalized Catallaxy campaign after every checkpoint file has been written to staging.",
  promptSnippet: "Launch the finalized campaign once all checkpoint files exist in private staging",
  promptGuidelines: [
    "Use catallaxy_launch_campaign only after writing every staged file returned by catallaxy_finalize_campaign_plan.",
    "catallaxy_launch_campaign posts the first checkpoint task; do not also run implementation work yourself.",
  ],
  parameters: Type.Object({
    campaignId: Type.String({ description: "Campaign id previously saved by catallaxy_finalize_campaign_plan" }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const root = catallaxyRoot(ctx.cwd);
    const plan = await loadCampaignPlan(root, params.campaignId);
    const missing = missingStagedFiles(root, plan);
    if (missing.length > 0) throw new Error(`missing staged files: ${missing.join(", ")}`);

    if (ctx.hasUI) {
      const ok = await withPlainHeader(ctx, () => ctx.ui.confirm(
        "Launch Catallaxy campaign?",
        `Post checkpoint 1/${plan.checkpoints.length} for ${plan.title}? Later checkpoints will post automatically after LGTM.`,
      ));
      if (!ok) {
        return { content: [{ type: "text", text: "Launch cancelled by user." }], details: { cancelled: true } };
      }
    }

    const launched = await launchCampaign(root, plan);
    return {
      content: [{ type: "text", text: `Launched ${launched.taskId} for campaign ${launched.campaignId} checkpoint ${launched.checkpointIndex + 1}/${plan.checkpoints.length}. Catallaxy watcher will wake agents for bidding if it is running; later checkpoints advance automatically after LGTM.` }],
      details: { launched, plan },
      terminate: true,
    };
  },
  renderResult(result, _options, theme) {
    const launched = result.details?.launched as { taskId: string; campaignId: string; checkpointIndex: number } | undefined;
    const plan = result.details?.plan as CampaignPlanRecord | undefined;
    if (!launched) return new Text(result.content?.[0]?.type === "text" ? result.content[0].text : "", 0, 0);
    return new Text([
      theme.fg("success", theme.bold(`Launched ${launched.taskId}`)),
      theme.fg("muted", `campaign: ${launched.campaignId}`),
      theme.fg("muted", `checkpoint: ${launched.checkpointIndex + 1}/${plan?.checkpoints.length ?? "?"}`),
      theme.fg("muted", "Run/attach watcher separately with make watch."),
    ].join("\n"), 0, 0);
  },
});

function approvedMutationRoot(root: string, plan: CampaignPlanRecord): string[] {
  return [campaignDir(root, plan.campaignId), plan.repo];
}

export default function catallaxyInterface(pi: ExtensionAPI): void {
  if (!isCatallaxyInterfaceEnabled()) return;

  let campaignMode = true;
  let planApproved = false;
  let activeCampaignId: string | undefined;

  function enterCampaignMode(ctx?: ExtensionContext): void {
    campaignMode = true;
    planApproved = false;
    activeCampaignId = undefined;
    pi.setActiveTools(PLANNING_TOOLS);
    if (ctx?.hasUI) ctx.ui.setWidget("catallaxy-interface", undefined);
    if (ctx) updateStatus(ctx, true);
  }

  pi.registerTool(finalizeCampaignTool);
  pi.registerTool(launchCampaignTool);

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    const text = event.text.trim();
    if (!text || text.startsWith("/")) return { action: "continue" as const };
    if (!campaignMode) enterCampaignMode(ctx);
    return { action: "continue" as const };
  });

  pi.on("tool_call", async (event, ctx) => {
    const root = catallaxyRoot(ctx.cwd);
    if (campaignMode && planApproved && activeCampaignId) {
      const plan = await loadCampaignPlan(root, activeCampaignId).catch(() => undefined);
      if (isWriteTool(event.toolName)) {
        const rawPath = String((event.input as { path?: unknown }).path ?? "").replace(/^@/, "");
        const path = resolve(ctx.cwd, rawPath);
        const plannedPaths = plan ? campaignStagedFiles(root, plan).map((f) => resolve(f.stagedPath)) : [];
        if (!plan || !plannedPaths.includes(path)) {
          return { block: true, reason: `Catallaxy interface: after approval, writes are allowed only to staged files listed in the approved campaign plan under ${plan ? campaignStagingDir(root, plan.campaignId) : "(unknown)"}` };
        }
      }
      if (event.toolName === "bash") {
        const command = String((event.input as { command?: unknown }).command ?? "");
        const roots = plan ? approvedMutationRoot(root, plan) : [];
        if (!isSafePlanningBash(command) && !roots.some((r) => command.includes(r))) {
          return { block: true, reason: `Catallaxy interface: mutating/test bash commands must explicitly operate inside campaign staging or worktree: ${roots.join(" or ") || "(unknown)"}` };
        }
      }
      return;
    }

    if (isWriteTool(event.toolName)) {
      return { block: true, reason: "Catallaxy interface: user must approve a test-first campaign plan before file writes are allowed." };
    }
    if (event.toolName === "catallaxy_launch_campaign") {
      return { block: true, reason: "Catallaxy interface: launch is blocked until the user approves the campaign plan and all staged files are written." };
    }
    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      if (!isSafePlanningBash(command)) {
        return { block: true, reason: `Catallaxy interface: bash is read-only until the user approves a campaign plan. Blocked command: ${command}` };
      }
    }
  });

  pi.on("before_agent_start", async () => {
    if (!campaignMode) return;
    return {
      message: {
        customType: "catallaxy-campaign-context",
        content: campaignSystem,
        display: false,
      },
    };
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName === "catallaxy_finalize_campaign_plan" && !event.isError) {
      const approved = event.result.details?.approved === true;
      activeCampaignId = event.result.details?.plan?.campaignId;
      planApproved = approved;
      if (approved) pi.setActiveTools(APPROVED_TOOLS);
      else pi.setActiveTools(PLANNING_TOOLS);
      updateStatus(ctx, campaignMode, activeCampaignId);
    }
    if (event.toolName === "catallaxy_launch_campaign" && !event.isError && event.result.details?.launched) {
      planApproved = false;
      activeCampaignId = undefined;
      pi.setActiveTools(PLANNING_TOOLS);
      updateStatus(ctx, campaignMode, activeCampaignId);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    enterCampaignMode(ctx);
    installGalaxyHeader(ctx);
  });
}
