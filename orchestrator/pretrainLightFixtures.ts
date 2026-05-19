import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PretrainTaskTemplate } from "./pretrainTasks";
import { LIGHT_PRETRAIN_REPOS } from "./pretrainLightTasks";

interface Fixture {
  files: Record<string, string>;
}

function readme(slug: string): string {
  return `# ${slug}\n\nSmall existing project used by Catallaxy light pretrain. The current issue is represented by regression tests in tests/. Make a focused production-style patch.\n`;
}

function tsPackage(slug: string): string {
  return JSON.stringify({
    name: slug,
    private: true,
    type: "module",
    scripts: { test: "bun test" },
  }, null, 2) + "\n";
}

function tsFixture(slug: string, index: string, test: string): Fixture {
  return {
    files: {
      "README.md": readme(slug),
      "package.json": tsPackage(slug),
      "src/index.ts": index,
      "tests/contract.test.ts": test,
    },
  };
}

function pyFixture(slug: string, solution: string, test: string): Fixture {
  return {
    files: {
      "README.md": readme(slug),
      "solution.py": solution,
      "tests/test_contract.py": test,
    },
  };
}

function rustFixture(slug: string, lib: string, test: string): Fixture {
  const crate = slug.replaceAll("-", "_");
  return {
    files: {
      "README.md": readme(slug),
      "Cargo.toml": `[package]\nname = "${crate}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`,
      "src/lib.rs": lib,
      "tests/contract.rs": test,
    },
  };
}

const FIXTURES: Record<string, Fixture> = {
  "ts-env-defaults-validator": tsFixture("ts-env-defaults-validator", String.raw`export type Env = Record<string, string>;

export interface MergeOptions {
  defaults?: Env;
}

export interface SchemaRule {
  required?: boolean;
  allowedValues?: string[];
}

export type EnvSchema = Record<string, SchemaRule>;

export interface EnvDiagnostic {
  key: string;
  code: string;
  message: string;
}

export function parseEnv(text: string): Env {
  const out: Env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export function mergeEnv(layers: string[], options: MergeOptions = {}): Env {
  const merged: Env = { ...(options.defaults ?? {}) };
  for (const layer of layers) Object.assign(merged, parseEnv(layer));
  return merged;
}

export function validateEnv(_env: Env, _schema: EnvSchema): { ok: boolean; errors: EnvDiagnostic[] } {
  return { ok: true, errors: [] };
}

export function renderEnv(env: Env, _options: { redactKeys?: string[] } = {}): string {
  return Object.entries(env).map(([k, v]) => k + "=" + v).join("\n") + "\n";
}
`, String.raw`import { expect, test } from "bun:test";
import { mergeEnv, renderEnv, validateEnv } from "../src/index";

test("merges defaults first and lets later env layers override", () => {
  const env = mergeEnv(["PORT=3000\nMODE=prod", "MODE=dev\nTOKEN=secret"], { defaults: { HOST: "0.0.0.0", MODE: "prod" } });
  expect(env).toEqual({ HOST: "0.0.0.0", MODE: "dev", PORT: "3000", TOKEN: "secret" });
});

test("validates required keys and allowed values with stable diagnostics", () => {
  const report = validateEnv({ MODE: "qa" }, { PORT: { required: true }, MODE: { allowedValues: ["dev", "prod"] } });
  expect(report.ok).toBe(false);
  expect(report.errors).toEqual([
    { key: "MODE", code: "value.not_allowed", message: "MODE must be one of: dev, prod" },
    { key: "PORT", code: "key.required", message: "PORT is required" },
  ]);
});

test("renders env deterministically and redacts configured secret keys", () => {
  const env = { TOKEN: "secret", A: "1" };
  expect(renderEnv(env, { redactKeys: ["TOKEN"] })).toBe("A=1\nTOKEN=<redacted>\n");
  expect(env.TOKEN).toBe("secret");
});
`),

  "ts-release-note-summarizer": tsFixture("ts-release-note-summarizer", String.raw`export interface CommitEntry {
  type: string;
  scope?: string;
  title: string;
}

export function parseCommit(message: string): CommitEntry | null {
  const first = message.split(/\r?\n/, 1)[0];
  const match = first.match(/^(\w+)(?:\(([^)]+)\))?:\s+(.+)$/);
  if (!match) return null;
  return { type: match[1], scope: match[2], title: match[3] };
}

export function summarize(messages: string[]) {
  const entries = messages.map(parseCommit).filter((x): x is CommitEntry => Boolean(x));
  return { entries };
}
`, String.raw`import { expect, test } from "bun:test";
import { summarize } from "../src/index";

test("keeps the existing flat summary entries", () => {
  const report = summarize(["fix(api): stop retry storm", "docs: update readme"]);
  expect(report.entries.map((e: any) => e.title)).toEqual(["stop retry storm", "update readme"]);
});

test("groups scoped commits by package in stable order", () => {
  const report = summarize(["feat(web): add settings panel", "fix(api): stop retry storm", "chore(api): update fixtures"]);
  expect(Object.keys(report.packages)).toEqual(["api", "web"]);
  expect(report.packages.api.entries.map((e: any) => e.title)).toEqual(["stop retry storm", "update fixtures"]);
});

test("detects breaking changes from bang headers and footers", () => {
  const report = summarize(["feat(api)!: drop v1 auth", "fix(web): cookie mode\n\nBREAKING CHANGE: session cookies are host-only"]);
  expect(report.packages.api.breaking).toEqual(["drop v1 auth"]);
  expect(report.packages.web.breaking).toEqual(["session cookies are host-only"]);
});
`),

  "ts-feature-flag-expiry-linter": tsFixture("ts-feature-flag-expiry-linter", String.raw`export interface FlagConfig {
  key: string;
  owner?: string;
  expiresAt?: string;
  enabled?: boolean;
}

export interface Diagnostic {
  code: string;
  severity: "warning" | "error";
  path: string;
  message: string;
}

export function lintFlags(flags: FlagConfig[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i].owner) diagnostics.push({ code: "owner.missing", severity: "warning", path: "flags[" + i + "].owner", message: flags[i].key + " has no owner" });
  }
  return diagnostics;
}
`, String.raw`import { expect, test } from "bun:test";
import { lintFlags } from "../src/index";

test("reports duplicates, unknown owners, and expired flags deterministically", () => {
  const diagnostics = lintFlags([
    { key: "checkout-v2", owner: "platform", expiresAt: "2026-04-01T00:00:00Z" },
    { key: "checkout-v2", owner: "unknown", expiresAt: "2026-05-18T00:00:00Z" },
    { key: "search-redesign", expiresAt: "2026-08-01T00:00:00Z" },
  ], { knownOwners: ["platform", "growth"], now: new Date("2026-05-19T00:00:00Z"), expiryGraceDays: 7 });

  expect(diagnostics.map((d: any) => d.code)).toEqual([
    "flag.duplicate_key",
    "flag.expired",
    "owner.unknown",
    "owner.missing",
  ]);
  expect(diagnostics.find((d: any) => d.code === "flag.expired").severity).toBe("error");
  expect(diagnostics.every((d: any) => d.path.startsWith("flags["))).toBe(true);
});
`),

  "ts-incident-window-aggregator": tsFixture("ts-incident-window-aggregator", String.raw`export interface IncidentEvent {
  service: string;
  severity: string;
  ts: number;
}

export function countByService(events: IncidentEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of events) out[event.service] = (out[event.service] ?? 0) + 1;
  return out;
}

export function totalCount(events: IncidentEvent[]): number {
  return events.length;
}
`, String.raw`import { expect, test } from "bun:test";
import { aggregateWindows, countByService, totalCount } from "../src/index";

const events = [
  { service: "api", severity: "sev1", ts: 1_000 },
  { service: "api", severity: "sev2", ts: 4_000 },
  { service: "worker", severity: "sev1", ts: 9_000 },
];

test("preserves existing total and service counts", () => {
  expect(totalCount(events)).toBe(3);
  expect(countByService(events)).toEqual({ api: 2, worker: 1 });
});

test("aggregates rolling windows by service and severity with empty buckets", () => {
  const out = aggregateWindows(events, {
    now: 10_000,
    services: ["api", "worker", "web"],
    severities: ["sev1"],
    windows: [{ label: "5s", sizeMs: 5_000 }, { label: "10s", sizeMs: 10_000 }],
  });
  expect(out["5s"].api).toBe(0);
  expect(out["5s"].worker).toBe(1);
  expect(out["5s"].web).toBe(0);
  expect(out["10s"].api).toBe(1);
});
`),

  "py-log-redactor-json-fields": pyFixture("py-log-redactor-json-fields", String.raw`import re

class LogRedactor:
    def __init__(self, fields):
        self.fields = set(fields)
        self._metrics = {field: 0 for field in self.fields}

    def redact_line(self, line):
        for field in self.fields:
            pattern = rf"{re.escape(field)}=\S+"
            if re.search(pattern, line):
                self._metrics[field] += len(re.findall(pattern, line))
                line = re.sub(pattern, f"{field}=<redacted>", line)
        return line

    def metrics(self):
        return dict(self._metrics)
`, String.raw`import json, unittest
from solution import LogRedactor

class LogRedactorContract(unittest.TestCase):
    def test_redacts_nested_json_fields_and_counts_metrics(self):
        r = LogRedactor(["password", "token"])
        out = r.redact_line('{"user":"alice","password":"p","nested":{"token":"t"},"items":[{"token":"u"}]}')
        decoded = json.loads(out)
        self.assertEqual(decoded["password"], "<redacted>")
        self.assertEqual(decoded["nested"]["token"], "<redacted>")
        self.assertEqual(decoded["items"][0]["token"], "<redacted>")
        self.assertEqual(r.metrics(), {"password": 1, "token": 2})

    def test_keeps_plain_text_redaction_and_handles_bad_json(self):
        r = LogRedactor(["token"])
        self.assertEqual(r.redact_line("level=info token=abc ok=yes"), "level=info token=<redacted> ok=yes")
        self.assertEqual(r.redact_line('{bad json token=abc'), '{bad json token=<redacted>')

if __name__ == "__main__":
    unittest.main()
`),

  "py-runbook-link-checker": pyFixture("py-runbook-link-checker", String.raw`import re

class Diagnostic:
    def __init__(self, code, line, message):
        self.code = code
        self.line = line
        self.message = message
    def __eq__(self, other):
        return isinstance(other, Diagnostic) and (self.code, self.line, self.message) == (other.code, other.line, other.message)
    def __repr__(self):
        return f"Diagnostic({self.code!r}, {self.line!r}, {self.message!r})"

def check_runbook(text, required_headings=("Overview", "Rollback")):
    headings = set(re.findall(r"^#+\s+(.+)$", text, flags=re.MULTILINE))
    diagnostics = []
    for heading in required_headings:
        if heading not in headings:
            diagnostics.append(Diagnostic("heading.missing", 1, f"missing heading: {heading}"))
    return diagnostics
`, String.raw`import unittest
from solution import check_runbook

class RunbookCheckerContract(unittest.TestCase):
    def test_required_headings_duplicates_and_same_file_links(self):
        text = """# Deploy API

See [rollback](#rollback-plan) and [missing](#does-not-exist).

## Rollback Plan
steps

## Rollback Plan
more
"""
        diagnostics = check_runbook(text, required_headings=("Deploy API", "Rollback Plan"))
        self.assertEqual([d.code for d in diagnostics], ["anchor.duplicate", "link.missing"])
        self.assertEqual(diagnostics[0].line, 8)
        self.assertIn("rollback-plan", diagnostics[0].message)
        self.assertEqual(diagnostics[1].line, 3)
        self.assertIn("does-not-exist", diagnostics[1].message)

if __name__ == "__main__":
    unittest.main()
`),

  "py-webhook-retry-scheduler": pyFixture("py-webhook-retry-scheduler", String.raw`class RetryDecision:
    def __init__(self, delivery_id, attempt, retry_at=None, status="scheduled"):
        self.delivery_id = delivery_id
        self.attempt = attempt
        self.retry_at = retry_at
        self.status = status

class RetryScheduler:
    def __init__(self, base_seconds=1, max_seconds=60):
        self.base_seconds = base_seconds
        self.max_seconds = max_seconds
        self.attempts = {}

    def record_failure(self, delivery_id, now):
        attempt = self.attempts.get(delivery_id, 0) + 1
        self.attempts[delivery_id] = attempt
        delay = min(self.max_seconds, self.base_seconds * (2 ** (attempt - 1)))
        return RetryDecision(delivery_id, attempt, retry_at=now + delay)
`, String.raw`import unittest
from solution import RetryScheduler

class RetrySchedulerContract(unittest.TestCase):
    def test_seeded_jitter_is_deterministic_and_duplicate_failures_are_idempotent(self):
        a = RetryScheduler(base_seconds=10, max_seconds=60, jitter_seconds=3, seed=7, max_elapsed_seconds=120)
        b = RetryScheduler(base_seconds=10, max_seconds=60, jitter_seconds=3, seed=7, max_elapsed_seconds=120)
        first = a.record_failure("evt-1", now=100)
        duplicate = a.record_failure("evt-1", now=100)
        self.assertEqual(first.retry_at, duplicate.retry_at)
        self.assertEqual(first.attempt, 1)
        self.assertEqual(first.retry_at, b.record_failure("evt-1", now=100).retry_at)
        self.assertTrue(107 <= first.retry_at <= 113)

    def test_max_elapsed_budget_dead_letters_delivery(self):
        s = RetryScheduler(base_seconds=10, max_seconds=60, jitter_seconds=0, seed=1, max_elapsed_seconds=25)
        self.assertEqual(s.record_failure("evt-2", now=100).status, "scheduled")
        self.assertEqual(s.record_failure("evt-2", now=111).status, "scheduled")
        dead = s.record_failure("evt-2", now=130)
        self.assertEqual(dead.status, "dead_letter")
        self.assertIsNone(dead.retry_at)

if __name__ == "__main__":
    unittest.main()
`),

  "py-config-drift-report": pyFixture("py-config-drift-report", String.raw`class Drift:
    def __init__(self, path, desired, observed, severity="warning"):
        self.path = path
        self.desired = desired
        self.observed = observed
        self.severity = severity

class DriftReport:
    def __init__(self, changes):
        self.changes = changes
        self.summary = {"warning": len(changes), "error": 0}


def compare_config(desired, observed):
    changes = []
    for key, value in desired.items():
        if observed.get(key) != value:
            changes.append(Drift(key, value, observed.get(key)))
    return DriftReport(changes)
`, String.raw`import unittest
from solution import compare_config

class ConfigDriftContract(unittest.TestCase):
    def test_ignore_patterns_critical_prefixes_and_summary(self):
        desired = {"database": {"host": "db1", "port": 5432}, "feature": {"enabled": True}, "metadata": {"deployed_by": "ci"}}
        observed = {"database": {"host": "db2", "port": 5432}, "feature": {"enabled": False}, "metadata": {"deployed_by": "alice"}}
        report = compare_config(desired, observed, ignore=["metadata.*"], critical_prefixes=["database"])
        self.assertEqual([(c.path, c.severity) for c in report.changes], [("database.host", "error"), ("feature.enabled", "warning")])
        self.assertEqual(report.summary, {"error": 1, "warning": 1})

if __name__ == "__main__":
    unittest.main()
`),

  "py-csv-schema-profiler": pyFixture("py-csv-schema-profiler", String.raw`import csv
from io import StringIO

def profile_csv(text, null_values=None):
    reader = csv.DictReader(StringIO(text))
    rows = list(reader)
    columns = {}
    for name in reader.fieldnames or []:
        values = [row.get(name, "") for row in rows]
        columns[name] = {"type": "string", "count": len(values)}
    return {"row_count": len(rows), "columns": columns}
`, String.raw`import json, unittest
from solution import profile_csv

class CsvProfilerContract(unittest.TestCase):
    def test_null_ratios_bad_values_and_json_serializable_output(self):
        text = "id,age,score\n1,42,9.5\n2,,oops\n3,NA,7.0\n4,39,8.0\n"
        profile = profile_csv(text, null_values={"", "NA"})
        self.assertEqual(profile["row_count"], 4)
        self.assertEqual(profile["columns"]["age"]["type"], "integer")
        self.assertEqual(profile["columns"]["age"]["null_count"], 2)
        self.assertEqual(profile["columns"]["age"]["null_ratio"], 0.5)
        self.assertEqual(profile["columns"]["score"]["type"], "float")
        self.assertIn("oops", profile["columns"]["score"]["bad_values"])
        json.dumps(profile, sort_keys=True)

if __name__ == "__main__":
    unittest.main()
`),

  "py-api-token-scope-audit": pyFixture("py-api-token-scope-audit", String.raw`class Finding:
    def __init__(self, token_id, severity, code, message):
        self.token_id = token_id
        self.severity = severity
        self.code = code
        self.message = message


def audit_tokens(tokens, roles, now, stale_days, allowed_scopes):
    findings = []
    for token in tokens:
        scopes = set(token.get("scopes", []))
        extra = scopes - set(allowed_scopes)
        if extra:
            findings.append(Finding(token["id"], "high", "scope.overbroad", ",".join(sorted(extra))))
    return findings
`, String.raw`import unittest
from solution import audit_tokens

class TokenAuditContract(unittest.TestCase):
    def test_role_scope_expansion_stale_tokens_and_stable_sorting(self):
        tokens = [
            {"id": "t2", "scopes": ["read"], "roles": [], "last_used": 1_600_000_000},
            {"id": "t1", "scopes": ["read"], "roles": ["admin"], "last_used": 1_700_000_000},
        ]
        roles = {"admin": ["read", "write", "delete"]}
        findings = audit_tokens(tokens, roles, now=1_710_000_000, stale_days=30, allowed_scopes={"read", "write"})
        self.assertEqual([(f.token_id, f.code) for f in findings], [("t1", "scope.overbroad"), ("t2", "token.stale")])
        self.assertEqual(findings[0].severity, "high")
        self.assertIn("delete", findings[0].message)

if __name__ == "__main__":
    unittest.main()
`),

  "rust-sliding-rate-limiter": rustFixture("rust-sliding-rate-limiter", String.raw`use std::collections::HashMap;

#[derive(Debug, PartialEq, Eq)]
pub struct Decision {
    pub allowed: bool,
    pub retry_after_ms: Option<u64>,
}

pub struct RateLimiter {
    limit: usize,
    window_ms: u64,
    counts: HashMap<String, (u64, usize)>,
}

impl RateLimiter {
    pub fn new(limit: usize, window_ms: u64) -> Self {
        Self { limit, window_ms, counts: HashMap::new() }
    }

    pub fn check(&mut self, key: &str, now_ms: u64) -> Decision {
        let entry = self.counts.entry(key.to_string()).or_insert((now_ms, 0));
        if now_ms.saturating_sub(entry.0) >= self.window_ms {
            *entry = (now_ms, 0);
        }
        if entry.1 < self.limit {
            entry.1 += 1;
            Decision { allowed: true, retry_after_ms: None }
        } else {
            Decision { allowed: false, retry_after_ms: Some(self.window_ms) }
        }
    }
}
`, String.raw`use rust_sliding_rate_limiter::RateLimiter;

#[test]
fn sliding_window_prunes_old_events_and_reports_retry_after() {
    let mut limiter = RateLimiter::new(2, 1_000);
    assert!(limiter.check("ip", 0).allowed);
    assert!(limiter.check("ip", 100).allowed);
    let rejected = limiter.check("ip", 900);
    assert!(!rejected.allowed);
    assert_eq!(rejected.retry_after_ms, Some(100));
    assert!(limiter.check("ip", 1_000).allowed);
}

#[test]
fn keys_are_isolated() {
    let mut limiter = RateLimiter::new(1, 1_000);
    assert!(limiter.check("a", 10).allowed);
    assert!(!limiter.check("a", 20).allowed);
    assert!(limiter.check("b", 20).allowed);
}
`),

  "rust-ini-editor-preserve-comments": rustFixture("rust-ini-editor-preserve-comments", String.raw`pub fn get_value(input: &str, section: &str, key: &str) -> Option<String> {
    let mut current = "";
    for line in input.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            current = &trimmed[1..trimmed.len() - 1];
        } else if current == section {
            if let Some((k, v)) = trimmed.split_once('=') {
                if k.trim() == key { return Some(v.trim().to_string()); }
            }
        }
    }
    None
}

pub fn set_value(input: &str, section: &str, key: &str, value: &str) -> String {
    let mut out = String::new();
    out.push_str(input.trim_end());
    out.push('\n');
    out.push_str(&format!("[{}]\n{}={}\n", section, key, value));
    out
}
`, String.raw`use rust_ini_editor_preserve_comments::{get_value, set_value};

#[test]
fn updates_existing_key_in_place_and_preserves_comments() {
    let input = "# global\n[server]\n# host comment\nhost=old\n\n[client]\nname=cli\n";
    let out = set_value(input, "server", "host", "new");
    assert!(out.contains("# global\n[server]\n# host comment\nhost=new"));
    assert_eq!(out.matches("host=").count(), 1);
    assert_eq!(get_value(&out, "server", "host"), Some("new".to_string()));
}

#[test]
fn appends_missing_key_to_existing_section_or_creates_section_at_end() {
    let input = "[server]\nhost=old\n\n[client]\nname=cli\n";
    let out = set_value(input, "server", "port", "8080");
    assert!(out.find("port=8080").unwrap() < out.find("[client]").unwrap());
    let out = set_value(input, "metrics", "enabled", "true");
    assert!(out.ends_with("\n[metrics]\nenabled=true\n"));
}
`),

  "rust-cli-table-truncation": rustFixture("rust-cli-table-truncation", String.raw`pub struct TableOptions {
    pub max_widths: Vec<Option<usize>>,
}

pub fn render_table(headers: &[&str], rows: &[Vec<&str>]) -> String {
    let mut widths: Vec<usize> = headers.iter().map(|h| h.len()).collect();
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            widths[i] = widths[i].max(cell.len());
        }
    }
    let mut out = String::new();
    for (i, header) in headers.iter().enumerate() {
        out.push_str(&format!("{:<width$}", header, width = widths[i]));
        if i + 1 < headers.len() { out.push_str(" | "); }
    }
    out.push('\n');
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            out.push_str(&format!("{:<width$}", cell, width = widths[i]));
            if i + 1 < headers.len() { out.push_str(" | "); }
        }
        out.push('\n');
    }
    out
}

pub fn render_table_with_options(headers: &[&str], rows: &[Vec<&str>], _options: TableOptions) -> String {
    render_table(headers, rows)
}
`, String.raw`use rust_cli_table_truncation::{render_table, render_table_with_options, TableOptions};

#[test]
fn old_render_table_api_still_works() {
    let out = render_table(&["Name", "Status"], &[vec!["api", "ok"]]);
    assert!(out.contains("Name"));
    assert!(out.contains("api"));
}

#[test]
fn truncates_cells_to_max_widths_and_keeps_alignment() {
    let out = render_table_with_options(
        &["Name", "Status"],
        &[vec!["alpha-service", "degraded"], vec!["b", "ok"]],
        TableOptions { max_widths: vec![Some(6), Some(8)] },
    );
    let lines: Vec<&str> = out.lines().collect();
    assert!(lines[1].starts_with("alpha… | degraded"));
    assert!(lines[2].starts_with("b      | ok"));
}

#[test]
fn empty_rows_do_not_panic() {
    let out = render_table_with_options(&["Only"], &[], TableOptions { max_widths: vec![Some(4)] });
    assert!(out.contains("Only"));
}
`),

  "rust-audit-log-chain": rustFixture("rust-audit-log-chain", String.raw`#[derive(Clone, Debug)]
pub struct AuditEvent {
    pub actor: String,
    pub action: String,
    pub prev_hash: u64,
    pub hash: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct VerifyError {
    pub index: usize,
    pub message: String,
}

pub struct AuditLog {
    entries: Vec<AuditEvent>,
}

fn test_hash(actor: &str, action: &str) -> u64 {
    actor.bytes().chain(action.bytes()).fold(0u64, |acc, b| acc.wrapping_mul(131).wrapping_add(b as u64))
}

impl AuditLog {
    pub fn new() -> Self { Self { entries: Vec::new() } }
    pub fn append(&mut self, actor: &str, action: &str) {
        let hash = test_hash(actor, action);
        self.entries.push(AuditEvent { actor: actor.to_string(), action: action.to_string(), prev_hash: 0, hash });
    }
    pub fn entries(&self) -> &[AuditEvent] { &self.entries }
    pub fn verify_chain(&self) -> Result<(), VerifyError> { Self::verify_entries(&self.entries) }
    pub fn verify_entries(entries: &[AuditEvent]) -> Result<(), VerifyError> {
        for (i, event) in entries.iter().enumerate() {
            if event.hash != test_hash(&event.actor, &event.action) {
                return Err(VerifyError { index: i, message: "hash mismatch".to_string() });
            }
        }
        Ok(())
    }
}
`, String.raw`use rust_audit_log_chain::{AuditEvent, AuditLog};

#[test]
fn verifies_chained_entries_and_identifies_first_bad_index() {
    let mut log = AuditLog::new();
    log.append("alice", "login");
    log.append("alice", "delete-user");
    assert_eq!(log.verify_chain(), Ok(()));

    let mut tampered: Vec<AuditEvent> = log.entries().to_vec();
    tampered[0].action = "tampered".to_string();
    let err = AuditLog::verify_entries(&tampered).unwrap_err();
    assert_eq!(err.index, 0);

    let mut broken_link: Vec<AuditEvent> = log.entries().to_vec();
    broken_link[1].prev_hash = 123;
    let err = AuditLog::verify_entries(&broken_link).unwrap_err();
    assert_eq!(err.index, 1);
}
`),

  "ts-cors-policy-auditor": tsFixture("ts-cors-policy-auditor", String.raw`export interface CorsPolicy {
  name: string;
  origins: string[];
  allowCredentials: boolean;
}

export interface Finding {
  code: string;
  severity: "low" | "medium" | "high";
  policy: string;
  origin: string;
  remediation: string;
}

export function auditCors(policies: CorsPolicy[]): Finding[] {
  const findings: Finding[] = [];
  for (const policy of policies) {
    if (policy.allowCredentials && policy.origins.includes("*")) {
      findings.push({ code: "cors.wildcard_credentials", severity: "high", policy: policy.name, origin: "*", remediation: "Do not combine credentials with wildcard origins." });
    }
  }
  return findings;
}
`, String.raw`import { expect, test } from "bun:test";
import { auditCors } from "../src/index";

test("flags wildcard credentials and wildcard subdomains", () => {
  const findings = auditCors([
    { name: "api", origins: ["*"], allowCredentials: true },
    { name: "admin", origins: ["https://*.example.com"], allowCredentials: true },
  ]);
  expect(findings.map((f: any) => f.code)).toEqual(["cors.wildcard_credentials", "cors.wildcard_subdomain_credentials"]);
  expect(findings.every((f: any) => f.severity === "high" && f.remediation.length > 0)).toBe(true);
});

test("normalizes origins and deduplicates equivalent findings", () => {
  const findings = auditCors([{ name: "web", origins: ["HTTPS://App.Example.com/", "https://app.example.com"], allowCredentials: false }]);
  expect(findings).toEqual([
    { code: "cors.duplicate_origin", severity: "medium", policy: "web", origin: "https://app.example.com", remediation: "Remove duplicate origin entries." },
  ]);
});
`),

  "py-slo-burn-rate-alerts": pyFixture("py-slo-burn-rate-alerts", String.raw`def availability(samples):
    total = sum(s.get("total", 0) for s in samples)
    bad = sum(s.get("bad", 0) for s in samples)
    if total == 0:
        return 1.0
    return 1.0 - bad / total

def evaluate_burn_rate(samples, objective, windows, now):
    return []
`, String.raw`import unittest
from solution import availability, evaluate_burn_rate

class SloBurnRateContract(unittest.TestCase):
    def test_availability_summary_is_unchanged(self):
        self.assertEqual(availability([{"total": 100, "bad": 1}]), 0.99)
        self.assertEqual(availability([]), 1.0)

    def test_multi_window_burn_rate_alerts_are_explainable(self):
        samples = [
            {"ts": 3_300, "total": 100, "bad": 10},
            {"ts": 1_000, "total": 10_000, "bad": 20},
        ]
        alerts = evaluate_burn_rate(samples, objective=0.99, windows=[("5m", 300, 5), ("1h", 3600, 20)], now=3_600)
        self.assertEqual([a.window for a in alerts], ["5m"])
        self.assertGreater(alerts[0].burn_rate, alerts[0].threshold)
        self.assertIn("5m", alerts[0].explain)
        self.assertIn("budget", alerts[0].explain)

if __name__ == "__main__":
    unittest.main()
`),
};

export const LIGHT_PRETRAIN_FIXTURE_SLUGS = Object.freeze(Object.keys(FIXTURES).sort());

async function writeFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, content.endsWith("\n") ? content : `${content}\n`);
}

async function git(repo: string, args: string[], allowExit: number[] = [0]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  if (!allowExit.includes(code)) throw new Error(`git -C ${repo} ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  return { code, stdout, stderr };
}

export async function ensureLightPretrainFixtures(tasks: readonly PretrainTaskTemplate[]): Promise<void> {
  const missing = tasks.map((t) => t.slug).filter((slug) => !FIXTURES[slug]);
  if (missing.length) throw new Error(`missing light pretrain fixture(s): ${missing.join(", ")}`);

  await mkdir(LIGHT_PRETRAIN_REPOS, { recursive: true });
  for (const task of tasks) {
    const repo = join(LIGHT_PRETRAIN_REPOS, task.slug);
    await rm(repo, { recursive: true, force: true });
    await mkdir(repo, { recursive: true });

    const fixture = FIXTURES[task.slug];
    for (const [rel, content] of Object.entries(fixture.files)) {
      await writeFile(join(repo, rel), content);
    }

    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["-c", "user.name=Catallaxy", "-c", "user.email=catallaxy@example.invalid", "commit", "-m", "Seed light pretrain project"]);
  }
}
