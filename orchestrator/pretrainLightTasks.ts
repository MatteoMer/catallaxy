import type { PretrainTaskTemplate } from "./pretrainTasks";

const ROOT = process.cwd();
export const LIGHT_PRETRAIN_REPOS = `${ROOT}/repos/light-pretrain`;

export const MIN_LIGHT_PRETRAIN_RESERVATION = 1_000_000;
export const DEFAULT_LIGHT_PRETRAIN_TASKS_PER_AGENT = 1;
export const DEFAULT_LIGHT_PRETRAIN_REVIEW_FEE = 20_000;

interface LightTaskSpec {
  slug: string;
  title: string;
  domain: string;
  reservation: number;
  check: string;
  requirements: string[];
  criteria?: string[];
  reviewFee?: number;
}

function makeLightTask(spec: LightTaskSpec): PretrainTaskTemplate {
  if (!Number.isInteger(spec.reservation) || spec.reservation < MIN_LIGHT_PRETRAIN_RESERVATION) {
    throw new Error(`${spec.slug}: reservation must be >= ${MIN_LIGHT_PRETRAIN_RESERVATION}`);
  }

  const repo = `${LIGHT_PRETRAIN_REPOS}/${spec.slug}`;
  const description = [
    `[pretrain-light:${spec.slug}] ${spec.title}.`,
    "",
    `Work in the existing git project cloned for this task. This is a small production-style change, not a kata: preserve the project shape, existing APIs, and tests unless a requirement explicitly changes them.`,
    "",
    "Change request:",
    ...spec.requirements.map((r, i) => `${i + 1}. ${r}`),
    "",
    `Deterministic acceptance check, run from the repository root: \`${spec.check}\``,
    "Keep the patch narrow. Do not delete, skip, or weaken regression tests; add focused docs/tests only if they help explain the production behavior.",
  ].join("\n");

  const subjectiveCriteria = [
    "Review as a real maintenance issue in an existing codebase.",
    "The implementation should be idiomatic for the project and avoid broad rewrites.",
    "Existing behavior must remain compatible unless the task explicitly asks for a change.",
    "Error cases should be handled deterministically and surfaced with useful messages/return values.",
    ...(spec.criteria ?? []),
  ].join("\n");

  return {
    slug: spec.slug,
    title: spec.title,
    domain: spec.domain,
    reservation: spec.reservation,
    reviewFee: spec.reviewFee ?? DEFAULT_LIGHT_PRETRAIN_REVIEW_FEE,
    check: spec.check,
    description,
    subjectiveCriteria,
    repo,
  };
}

export const LIGHT_PRETRAIN_TASKS: PretrainTaskTemplate[] = [
  makeLightTask({
    domain: "typescript-cli",
    slug: "ts-env-defaults-validator",
    title: "Add schema validation and redacted rendering to a .env merge helper",
    reservation: 1_700_000,
    check: "bun test",
    requirements: [
      "Implement the missing schema validation path for required keys and allowed values, returning stable diagnostic objects instead of throwing.",
      "Make rendered env output deterministic, sorted by key, and able to redact configured secret keys without mutating the original env object.",
      "Keep merge semantics intact: later layers override earlier ones and defaults are applied first.",
    ],
  }),
  makeLightTask({
    domain: "typescript-cli",
    slug: "ts-release-note-summarizer",
    title: "Teach a release-note summarizer to group scoped commits and flag breaking changes",
    reservation: 1_650_000,
    check: "bun test",
    requirements: [
      "Parse conventional-commit scopes as package names and group entries by package with stable alphabetical ordering.",
      "Detect breaking changes from either a bang marker in the header or a BREAKING CHANGE footer.",
      "Preserve the existing flat summary API while adding the grouped package summary used by CI release notes.",
    ],
  }),
  makeLightTask({
    domain: "typescript-tooling",
    slug: "ts-feature-flag-expiry-linter",
    title: "Add ownership and expiry policy checks to a feature-flag linter",
    reservation: 1_550_000,
    check: "bun test",
    requirements: [
      "Report duplicate flag keys, missing/unknown owners, and expired flags with stable diagnostic codes and paths.",
      "Support a configurable grace period for recently expired flags while still reporting long-expired flags as errors.",
      "Keep diagnostics sorted so CI output is deterministic.",
    ],
  }),
  makeLightTask({
    domain: "typescript-backend",
    slug: "ts-incident-window-aggregator",
    title: "Improve incident metrics rollups with sliding windows and severity filters",
    reservation: 1_750_000,
    check: "bun test",
    requirements: [
      "Add rolling-window aggregation by service and severity over timestamped incident events.",
      "Return stable empty buckets for services with no events in a window so dashboards do not jump.",
      "Preserve existing total-count behavior and avoid wall-clock time in tests or implementation.",
    ],
  }),
  makeLightTask({
    domain: "python-infra",
    slug: "py-log-redactor-json-fields",
    title: "Extend a log redactor to handle JSON payload fields and metrics",
    reservation: 1_600_000,
    check: "python3 -m unittest discover -s tests -v",
    requirements: [
      "Redact configured field names in JSON log lines, including nested dicts/lists, while preserving valid JSON output.",
      "Keep the existing key=value redaction behavior for plain text logs.",
      "Expose per-field redaction metrics and leave malformed JSON lines unchanged except for plain text redaction.",
    ],
  }),
  makeLightTask({
    domain: "python-tooling",
    slug: "py-runbook-link-checker",
    title: "Add same-file link and duplicate-anchor checks to a runbook validator",
    reservation: 1_450_000,
    check: "python3 -m unittest discover -s tests -v",
    requirements: [
      "Detect duplicate generated markdown anchors with useful line numbers.",
      "Validate same-file heading links like #rollback-plan and report missing anchors without attempting network access.",
      "Keep existing required-heading checks and return diagnostics in source order.",
    ],
  }),
  makeLightTask({
    domain: "python-backend",
    slug: "py-webhook-retry-scheduler",
    title: "Add deterministic jitter and retry budget enforcement to a webhook retry scheduler",
    reservation: 1_700_000,
    check: "python3 -m unittest discover -s tests -v",
    requirements: [
      "Implement exponential backoff with deterministic seedable jitter so retries spread out but tests remain stable.",
      "Stop scheduling retries once a max elapsed budget is exceeded and mark the delivery dead-lettered.",
      "Preserve idempotent scheduling for duplicate failure notifications.",
    ],
  }),
  makeLightTask({
    domain: "python-devops",
    slug: "py-config-drift-report",
    title: "Add ignore patterns and severity summaries to a config drift reporter",
    reservation: 1_500_000,
    check: "python3 -m unittest discover -s tests -v",
    requirements: [
      "Support dotted-path ignore patterns with * wildcards when comparing desired and observed config dictionaries.",
      "Classify changes under configured critical prefixes as errors and all other drift as warnings.",
      "Return a stable summary by severity while preserving detailed path diagnostics.",
    ],
  }),
  makeLightTask({
    domain: "python-data",
    slug: "py-csv-schema-profiler",
    title: "Make a CSV schema profiler report null ratios and bad rows",
    reservation: 1_450_000,
    check: "python3 -m unittest discover -s tests -v",
    requirements: [
      "Track per-column inferred type, null count, null ratio, and example bad values while scanning rows.",
      "Treat empty strings and configured sentinels as nulls without poisoning numeric inference.",
      "Keep output deterministic and JSON-serializable for CI artifact upload.",
    ],
  }),
  makeLightTask({
    domain: "python-security",
    slug: "py-api-token-scope-audit",
    title: "Add scope inheritance and stale-token findings to an API-token auditor",
    reservation: 1_550_000,
    check: "python3 -m unittest discover -s tests -v",
    requirements: [
      "Expand role-based scopes into effective token scopes before policy comparison.",
      "Report stale tokens by last-used timestamp and over-broad tokens by extra effective scopes.",
      "Keep findings sorted by token id and severity for stable security reports.",
    ],
  }),
  makeLightTask({
    domain: "rust-infra",
    slug: "rust-sliding-rate-limiter",
    title: "Replace a fixed-window rate limiter with sliding-window retry advice",
    reservation: 1_850_000,
    check: "cargo test",
    requirements: [
      "Implement per-key sliding-window decisions using supplied timestamps, not wall-clock time.",
      "Return retry_after_ms for rejected requests based on the oldest retained event in the window.",
      "Keep memory bounded by pruning expired events on every decision.",
    ],
  }),
  makeLightTask({
    domain: "rust-tooling",
    slug: "rust-ini-editor-preserve-comments",
    title: "Make an INI editor preserve comments and section ordering when setting keys",
    reservation: 1_800_000,
    check: "cargo test",
    requirements: [
      "Update existing keys in place while preserving comments, blank lines, and section order.",
      "Append missing keys to an existing section or create a new section at the end if needed.",
      "Round-trip files with trailing newlines deterministically.",
    ],
  }),
  makeLightTask({
    domain: "rust-cli",
    slug: "rust-cli-table-truncation",
    title: "Add width-aware truncation to a CLI table renderer",
    reservation: 1_650_000,
    check: "cargo test",
    requirements: [
      "Support optional max column widths and truncate overflowing cells with an ellipsis.",
      "Keep alignment stable after truncation and handle empty rows without panics.",
      "Preserve the existing simple render_table API by adding a compatible options-based API.",
    ],
  }),
  makeLightTask({
    domain: "rust-security",
    slug: "rust-audit-log-chain",
    title: "Add chained integrity checks to an audit-log encoder",
    reservation: 1_900_000,
    check: "cargo test",
    requirements: [
      "Include previous-entry hash material when appending audit events so tampering in the middle is detectable.",
      "Expose verification that returns the index of the first bad event instead of only true/false.",
      "Keep the documented deterministic test hash and existing encode/decode behavior.",
    ],
  }),
  makeLightTask({
    domain: "typescript-security",
    slug: "ts-cors-policy-auditor",
    title: "Add wildcard and credential checks to a CORS policy auditor",
    reservation: 1_500_000,
    check: "bun test",
    requirements: [
      "Flag allowCredentials combined with wildcard origins or wildcard subdomains as high severity.",
      "Normalize origins before comparison and deduplicate equivalent findings.",
      "Produce stable remediation strings for CI comments.",
    ],
  }),
  makeLightTask({
    domain: "python-observability",
    slug: "py-slo-burn-rate-alerts",
    title: "Add multi-window burn-rate alert evaluation to an SLO helper",
    reservation: 1_700_000,
    check: "python3 -m unittest discover -s tests -v",
    requirements: [
      "Evaluate short and long error-budget burn windows over deterministic samples.",
      "Return explainable alert objects with consumed budget, threshold, and window labels.",
      "Keep existing availability calculations unchanged for callers that only need summaries.",
    ],
  }),
];
