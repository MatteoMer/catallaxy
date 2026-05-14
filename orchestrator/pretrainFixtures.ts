import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PretrainTaskTemplate } from "./pretrainTasks";

const ROOT = process.cwd();
const PLAYGROUND = `${ROOT}/repos/playground`;

interface Fixture {
  files: Record<string, string>;
}

function readme(slug: string): string {
  return `# ${slug}\n\nThis directory contains public acceptance tests for the Catallaxy pretrain task. Implement the task here, keep the tests meaningful, and make the task's deterministic check pass.\n`;
}

function tsPackage(name: string, next = false): string {
  return JSON.stringify({
    name,
    private: true,
    type: "module",
    scripts: next
      ? { build: "next build", test: "bun test" }
      : { test: "bun test", typecheck: "tsc --noEmit" },
    dependencies: next
      ? { "@types/node": "^22.0.0", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0", next: "^15.5.0", react: "^19.0.0", "react-dom": "^19.0.0", typescript: "^5.6.0" }
      : { "@types/bun": "^1.3.0", typescript: "^5.6.0" },
    devDependencies: {},
  }, null, 2) + "\n";
}

function tsconfig(next = false): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: next ? "ESNext" : "ESNext",
      moduleResolution: "bundler",
      strict: true,
      jsx: next ? "preserve" : undefined,
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true,
      types: next ? ["node"] : ["bun"],
    },
    include: next ? ["next-env.d.ts", "app/**/*.tsx", "src/**/*.ts", "tests/**/*.ts"] : ["src/**/*.ts", "tests/**/*.ts"],
  }, null, 2).replace(/\n    \"jsx\": undefined,/, "") + "\n";
}

function nextFixture(slug: string, test: string): Fixture {
  return {
    files: {
      "README.md": readme(slug),
      "package.json": tsPackage(slug, true),
      "tsconfig.json": tsconfig(true),
      "next.config.ts": "const nextConfig = {};\nexport default nextConfig;\n",
      "app/page.tsx": "import { TASK_TITLE } from '../src/domain';\n\nexport default function Page() {\n  return <main><h1>{TASK_TITLE}</h1><p>Implement the product UI and domain logic.</p></main>;\n}\n",
      "src/domain.ts": `export const TASK_TITLE = ${JSON.stringify(slug)};\n`,
      "tests/domain.test.ts": test,
    },
  };
}

function tsFixture(slug: string, test: string): Fixture {
  return {
    files: {
      "README.md": readme(slug),
      "package.json": tsPackage(slug),
      "tsconfig.json": tsconfig(false),
      "src/index.ts": "// Implement the public API exercised by tests/contract.test.ts.\n",
      "tests/contract.test.ts": test,
    },
  };
}

function pyFixture(slug: string, test: string): Fixture {
  return {
    files: {
      "README.md": readme(slug),
      "solution.py": "# Implement the public API exercised by tests/test_contract.py.\n",
      "tests/test_contract.py": test,
    },
  };
}

function rustFixture(slug: string, test: string): Fixture {
  const crate = slug.replaceAll("-", "_");
  return {
    files: {
      "README.md": readme(slug),
      "Cargo.toml": `[package]\nname = "${crate}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`,
      "src/lib.rs": "// Implement the public API exercised by tests/contract.rs.\n",
      "tests/contract.rs": test,
    },
  };
}

function cFixture(slug: string, header: string, test: string): Fixture {
  return {
    files: {
      "README.md": readme(slug),
      "Makefile": "CC ?= cc\nCFLAGS ?= -std=c11 -Wall -Wextra -Werror -O2 -I./src\n\n.PHONY: test clean\n\ntest: build/test_contract\n\t./build/test_contract\n\nbuild/test_contract: tests/test_contract.c src/solution.c src/solution.h\n\tmkdir -p build\n\t$(CC) $(CFLAGS) tests/test_contract.c src/solution.c -o $@\n\nclean:\n\trm -rf build\n",
      "src/solution.h": header,
      "src/solution.c": "#include \"solution.h\"\n/* Implement the API declared in solution.h. */\n",
      "tests/test_contract.c": test,
    },
  };
}

const FIXTURES: Record<string, Fixture> = {
  "nextjs-incident-command-center": nextFixture("nextjs-incident-command-center", String.raw`import { describe, expect, test } from "bun:test";
import { filterIncidents, transitionIncident, serializePostmortem } from "../src/domain";

describe("incident command center domain", () => {
  const incidents = [
    { id: "inc-1", severity: "sev1", status: "open", responder: "alice", timeline: [{ at: "2026-01-01T00:00:00Z", note: "api down" }] },
    { id: "inc-2", severity: "sev3", status: "mitigated", responder: "bob", timeline: [] },
  ];
  test("filters incidents by severity/status/responder", () => {
    expect(filterIncidents(incidents, { severity: "sev1", status: "open", responder: "alice" }).map((i: any) => i.id)).toEqual(["inc-1"]);
  });
  test("status transitions append an audit timeline note", () => {
    const next = transitionIncident(incidents[0], "mitigated", "carol", "rolled back deploy");
    expect(next.status).toBe("mitigated");
    expect(next.timeline.at(-1).note).toContain("carol");
    expect(next.timeline.at(-1).note).toContain("rolled back deploy");
  });
  test("postmortem serialization preserves severity and timeline", () => {
    const doc = serializePostmortem(incidents[0]);
    expect(doc).toContain("sev1");
    expect(doc).toContain("api down");
  });
});
`),

  "rust-lsm-kv": rustFixture("rust-lsm-kv", String.raw`use rust_lsm_kv::KvStore;
use std::time::{SystemTime, UNIX_EPOCH};

fn tmpdir(name: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    p.push(format!("catallaxy_{}_{}", name, n));
    std::fs::create_dir_all(&p).unwrap();
    p
}

#[test]
fn put_delete_flush_compact_and_recover() {
    let dir = tmpdir("lsm");
    let mut kv = KvStore::open(&dir).unwrap();
    kv.put(b"alpha".to_vec(), b"one".to_vec()).unwrap();
    kv.put(b"beta".to_vec(), b"two".to_vec()).unwrap();
    kv.flush().unwrap();
    kv.delete(b"alpha".to_vec()).unwrap();
    kv.flush().unwrap();
    kv.compact().unwrap();
    drop(kv);
    let kv = KvStore::open(&dir).unwrap();
    assert_eq!(kv.get(b"alpha").unwrap(), None);
    assert_eq!(kv.get(b"beta").unwrap(), Some(b"two".to_vec()));
}
`),

  "c-arena-allocator": cFixture("c-arena-allocator", String.raw`#pragma once
#include <stddef.h>

typedef struct Arena Arena;
typedef struct { size_t offset; } ArenaCheckpoint;
Arena *arena_create(size_t capacity);
void arena_destroy(Arena *arena);
void *arena_alloc(Arena *arena, size_t size, size_t alignment);
ArenaCheckpoint arena_checkpoint(Arena *arena);
void arena_rollback(Arena *arena, ArenaCheckpoint checkpoint);
void arena_reset(Arena *arena);
`, String.raw`#include "solution.h"
#include <assert.h>
#include <stdint.h>
#include <string.h>

int main(void) {
    Arena *arena = arena_create(128);
    assert(arena);
    void *a = arena_alloc(arena, 16, 16);
    assert(a && ((uintptr_t)a % 16) == 0);
    memset(a, 0xAB, 16);
    ArenaCheckpoint cp = arena_checkpoint(arena);
    void *b = arena_alloc(arena, 32, 32);
    assert(b && ((uintptr_t)b % 32) == 0);
    arena_rollback(arena, cp);
    void *c = arena_alloc(arena, 32, 32);
    assert(c == b);
    assert(arena_alloc(arena, (size_t)-1, 8) == 0);
    arena_destroy(arena);
    return 0;
}
`),

  "ts-openapi-breaking-change-detector": tsFixture("ts-openapi-breaking-change-detector", String.raw`import { describe, expect, test } from "bun:test";
import { diffOpenApi } from "../src/index";

describe("OpenAPI breaking change detector", () => {
  const oldSpec = { openapi: "3.0.0", paths: { "/users": { get: { responses: { "200": { content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "string" }, name: { type: "string" } } } } } } } } } } } };
  test("removed operations and newly required fields are breaking", () => {
    const next = { openapi: "3.0.0", paths: { "/users": { post: { responses: { "201": { description: "created" } } } } } };
    const report = diffOpenApi(oldSpec, next);
    expect(report.breaking.map((c: any) => c.code)).toContain("operation.removed");
  });
  test("response schema narrowing is reported with a stable path", () => {
    const next = structuredClone(oldSpec);
    next.paths["/users"].get.responses["200"].content["application/json"].schema.required.push("name");
    const report = diffOpenApi(oldSpec, next);
    expect(report.breaking.some((c: any) => c.path.includes("/users") && c.code === "response.required.added")).toBe(true);
  });
});
`),

  "py-async-crawler-frontier": pyFixture("py-async-crawler-frontier", String.raw`import unittest
from solution import CrawlerFrontier, RobotsRules, VirtualClock

class CrawlerFrontierContract(unittest.TestCase):
    def test_canonicalization_dedupes_and_respects_robots(self):
        clock = VirtualClock(start=0)
        robots = RobotsRules({"example.com": {"disallow": ["/private"], "crawl_delay": 5}})
        f = CrawlerFrontier(clock=clock, robots=robots)
        self.assertTrue(f.enqueue("HTTPS://example.com/a?b=1#frag"))
        self.assertFalse(f.enqueue("https://example.com/a?b=1"))
        self.assertFalse(f.enqueue("https://example.com/private/x"))
        lease = f.lease_next()
        self.assertEqual(lease.url, "https://example.com/a?b=1")
        self.assertIsNone(f.lease_next())
        clock.advance(5)
        f.complete(lease.id, status=200)
        self.assertEqual(f.metrics()["completed"], 1)

if __name__ == "__main__":
    unittest.main()
`),

  "py-sqlite-job-queue": pyFixture("py-sqlite-job-queue", String.raw`import os, tempfile, unittest
from solution import JobQueue, VirtualClock

class SQLiteJobQueueContract(unittest.TestCase):
    def test_leases_expire_retries_and_idempotency(self):
        with tempfile.TemporaryDirectory() as d:
            clock = VirtualClock(0)
            q = JobQueue(os.path.join(d, "jobs.db"), clock=clock)
            a = q.enqueue("email", {"to": "a@example.com"}, idempotency_key="same", priority=10)
            b = q.enqueue("email", {"to": "a@example.com"}, idempotency_key="same", priority=1)
            self.assertEqual(a, b)
            lease = q.lease(worker="w1", ttl_seconds=30)
            self.assertEqual(lease.job_id, a)
            self.assertIsNone(q.lease(worker="w2", ttl_seconds=30))
            clock.advance(31)
            lease2 = q.lease(worker="w2", ttl_seconds=30)
            self.assertEqual(lease2.job_id, a)
            q.fail(lease2.lease_id, "smtp down")
            self.assertEqual(q.stats()["retryable"], 1)

if __name__ == "__main__":
    unittest.main()
`),

  "rust-constant-time-token-vault": rustFixture("rust-constant-time-token-vault", String.raw`use rust_constant_time_token_vault::{constant_time_eq, TokenVault};

#[test]
fn token_lifecycle_expiry_rotation_and_revocation() {
    let mut v = TokenVault::new_for_tests(1000);
    let tok = v.issue("alice", &["read"], 60).unwrap();
    assert!(v.verify(&tok, 1001).unwrap().scopes.contains(&"read".to_string()));
    assert!(v.verify(&tok, 2000).is_err());
    let tok2 = v.rotate(&tok, 1002).unwrap();
    v.revoke(&tok2, "compromised").unwrap();
    assert!(v.verify(&tok2, 1003).is_err());
    assert!(v.audit_log().iter().any(|e| e.action == "revoke"));
}

#[test]
fn comparison_checks_all_bytes() {
    assert!(constant_time_eq(b"abcdef", b"abcdef"));
    assert!(!constant_time_eq(b"abcdef", b"abcdeg"));
    assert!(!constant_time_eq(b"short", b"longer"));
}
`),

  "py-k8s-controller-simulator": pyFixture("py-k8s-controller-simulator", String.raw`import unittest
from solution import FakeApiServer, RateLimitedQueue, WidgetController, VirtualClock

class K8sControllerContract(unittest.TestCase):
    def test_reconcile_is_idempotent_and_uses_finalizers(self):
        clock = VirtualClock(0)
        api = FakeApiServer()
        queue = RateLimitedQueue(clock)
        c = WidgetController(api, queue)
        api.apply({"kind": "Widget", "metadata": {"name": "a"}, "spec": {"replicas": 2}})
        c.reconcile("Widget/a")
        c.reconcile("Widget/a")
        deploy = api.get("Deployment/a")
        self.assertEqual(deploy["spec"]["replicas"], 2)
        self.assertEqual(api.get("Widget/a")["metadata"]["finalizers"], ["widgets.catallaxy/finalizer"])
        api.delete("Widget/a")
        c.reconcile("Widget/a")
        self.assertIsNone(api.get("Deployment/a"))
        self.assertIsNone(api.get("Widget/a"))

if __name__ == "__main__":
    unittest.main()
`),

  "nextjs-multi-tenant-billing-portal": nextFixture("nextjs-multi-tenant-billing-portal", String.raw`import { expect, test } from "bun:test";
import { canMutateBilling, changePlan, invoiceTotalCents, visibleInvoices } from "../src/domain";

test("viewer cannot mutate billing but owner can", () => {
  expect(canMutateBilling({ role: "viewer" })).toBe(false);
  expect(canMutateBilling({ role: "owner" })).toBe(true);
});

test("invoice totals are tenant scoped and deterministic", () => {
  const invoices = [{ id: "i1", tenantId: "t1", lines: [{ cents: 1200 }, { cents: -200 }] }, { id: "i2", tenantId: "t2", lines: [{ cents: 999 }] }];
  expect(visibleInvoices(invoices, "t1").map((i: any) => i.id)).toEqual(["i1"]);
  expect(invoiceTotalCents(invoices[0])).toBe(1000);
});

test("plan changes write audit metadata", () => {
  const tenant = changePlan({ id: "t1", plan: "starter", audit: [] }, "pro", { id: "u1", role: "owner" });
  expect(tenant.plan).toBe("pro");
  expect(tenant.audit.at(-1).actorId).toBe("u1");
});
`),

  "rust-wal-segment-recovery": rustFixture("rust-wal-segment-recovery", String.raw`use rust_wal_segment_recovery::Wal;
use std::time::{SystemTime, UNIX_EPOCH};

fn tmpdir() -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("catallaxy_wal_{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir_all(&p).unwrap();
    p
}

#[test]
fn replays_in_order_and_truncates_torn_tail() {
    let dir = tmpdir();
    let mut wal = Wal::open(&dir, 64).unwrap();
    wal.append(b"one").unwrap();
    wal.append(b"two").unwrap();
    wal.sync().unwrap();
    wal.inject_torn_tail_for_test(b"partial").unwrap();
    drop(wal);
    let mut recovered = Wal::open(&dir, 64).unwrap();
    assert_eq!(recovered.replay().unwrap(), vec![b"one".to_vec(), b"two".to_vec()]);
    assert!(recovered.repair().unwrap().truncated_bytes > 0);
}
`),

  "c-epoll-chat-server": cFixture("c-epoll-chat-server", String.raw`#pragma once
#include <stddef.h>

typedef enum { CHAT_LOGIN, CHAT_JOIN, CHAT_ROOM_MSG, CHAT_DM, CHAT_PING, CHAT_INVALID } ChatKind;
typedef struct { ChatKind kind; char user[32]; char target[32]; char body[256]; } ChatFrame;
int chat_parse_frame(const char *buf, size_t len, ChatFrame *out, size_t *consumed);
int chat_route_message(const ChatFrame *frame, char *out, size_t out_cap);
`, String.raw`#include "solution.h"
#include <assert.h>
#include <string.h>

int main(void) {
    ChatFrame f; size_t consumed = 0;
    const char *wire = "LOGIN alice\nJOIN ops\nMSG ops hello world\n";
    assert(chat_parse_frame(wire, strlen(wire), &f, &consumed) == 1);
    assert(f.kind == CHAT_LOGIN && strcmp(f.user, "alice") == 0);
    assert(consumed == strlen("LOGIN alice\n"));
    assert(chat_parse_frame("MSG ops partial", strlen("MSG ops partial"), &f, &consumed) == 0);
    char out[512];
    assert(chat_parse_frame("DM bob hi\n", strlen("DM bob hi\n"), &f, &consumed) == 1);
    assert(chat_route_message(&f, out, sizeof out) == 0);
    assert(strstr(out, "bob") && strstr(out, "hi"));
    return 0;
}
`),

  "ts-monorepo-task-runner": tsFixture("ts-monorepo-task-runner", String.raw`import { expect, test } from "bun:test";
import { affectedProjects, buildProjectGraph, scheduleTasks } from "../src/index";

test("discovers graph and schedules dependencies before dependents", () => {
  const graph = buildProjectGraph([
    { name: "core", deps: [], files: ["packages/core/a.ts"], tasks: { build: {} } },
    { name: "app", deps: ["core"], files: ["apps/app/a.ts"], tasks: { build: { dependsOn: ["^build"] } } },
  ]);
  expect(scheduleTasks(graph, ["app:build"]).map((t: any) => t.id)).toEqual(["core:build", "app:build"]);
});

test("affected filtering walks reverse dependencies", () => {
  const graph = buildProjectGraph([{ name: "core", deps: [], files: ["p/core/x.ts"], tasks: {} }, { name: "app", deps: ["core"], files: ["p/app/y.ts"], tasks: {} }]);
  expect(affectedProjects(graph, ["p/core/x.ts"])).toEqual(["core", "app"]);
});
`),

  "py-mini-sql-query-planner": pyFixture("py-mini-sql-query-planner", String.raw`import unittest
from solution import Database

class MiniSqlPlannerContract(unittest.TestCase):
    def test_join_group_order_and_explain_uses_index(self):
        db = Database()
        db.create_table("users", ["id", "team"])
        db.create_table("events", ["user_id", "kind"])
        db.insert("users", {"id": 1, "team": "ops"})
        db.insert("users", {"id": 2, "team": "ml"})
        db.insert("events", {"user_id": 1, "kind": "deploy"})
        db.create_index("events", "user_id")
        rows = db.query("SELECT users.team, count(*) AS n FROM users JOIN events ON users.id = events.user_id WHERE events.kind = 'deploy' GROUP BY users.team ORDER BY n DESC")
        self.assertEqual(rows, [{"team": "ops", "n": 1}])
        self.assertIn("index", db.explain("SELECT * FROM events WHERE user_id = 1").lower())

if __name__ == "__main__":
    unittest.main()
`),

  "ts-webhook-delivery-service": tsFixture("ts-webhook-delivery-service", String.raw`import { expect, test } from "bun:test";
import { DeliveryService, MemoryHttp, VirtualClock } from "../src/index";

test("signs, retries with backoff, and dead-letters", async () => {
  const clock = new VirtualClock(0);
  const http = new MemoryHttp([{ status: 500 }, { status: 500 }, { status: 200 }]);
  const svc = new DeliveryService({ clock, http, secrets: { ep1: "s1" } });
  svc.subscribe({ id: "ep1", url: "https://example.test/hook", events: ["user.created"] });
  await svc.publish({ id: "evt1", type: "user.created", payload: { id: "u1" } });
  expect(http.requests[0].headers["x-catallaxy-signature"]).toStartWith("v1=");
  clock.advance(1000); await svc.tick();
  clock.advance(2000); await svc.tick();
  expect(svc.deliveries("evt1").at(-1).status).toBe("succeeded");
});
`),

  "py-jwt-verifier-hs256": pyFixture("py-jwt-verifier-hs256", String.raw`import base64, hashlib, hmac, json, time, unittest
from solution import JwtVerifier, JwtError

def b64(obj):
    raw = json.dumps(obj, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

def sign(secret, head, payload):
    msg = f"{head}.{payload}".encode()
    return base64.urlsafe_b64encode(hmac.new(secret, msg, hashlib.sha256).digest()).rstrip(b"=").decode()

class JwtVerifierContract(unittest.TestCase):
    def test_validates_claims_and_rejects_alg_confusion(self):
        h = b64({"alg": "HS256", "typ": "JWT", "kid": "k1"})
        p = b64({"sub": "u1", "aud": "api", "iss": "issuer", "exp": 2000, "nbf": 1000, "iat": 1000})
        token = f"{h}.{p}.{sign(b'secret', h, p)}"
        verifier = JwtVerifier({"k1": b"secret"}, audience="api", issuer="issuer", now=lambda: 1500)
        self.assertEqual(verifier.verify(token)["sub"], "u1")
        none = b64({"alg": "none", "kid": "k1"}) + "." + p + "."
        with self.assertRaises(JwtError): verifier.verify(none)

if __name__ == "__main__":
    unittest.main()
`),

  "ts-docker-compose-dev-env-validator": tsFixture("ts-docker-compose-dev-env-validator", String.raw`import { expect, test } from "bun:test";
import { validateCompose } from "../src/index";

test("reports port conflicts, dependency cycles, secrets, and unpinned images", () => {
  const compose = { services: { web: { image: "node", ports: ["3000:3000"], depends_on: ["api"], environment: { API_KEY: "plain" } }, api: { image: "app:latest", ports: ["3000:8080"], depends_on: ["web"] } } };
  const report = validateCompose(compose);
  expect(report.diagnostics.map((d: any) => d.code)).toEqual(expect.arrayContaining(["port.conflict", "dependency.cycle", "secret.env", "image.unpinned"]));
  expect(report.diagnostics.every((d: any) => d.path && d.severity)).toBe(true);
});
`),

  "nextjs-feature-flag-console": nextFixture("nextjs-feature-flag-console", String.raw`import { expect, test } from "bun:test";
import { bucketUser, evaluateFlag, updateFlag } from "../src/domain";

test("percentage bucketing is deterministic", () => {
  expect(bucketUser("flag-a", "user-1")).toBe(bucketUser("flag-a", "user-1"));
  expect(bucketUser("flag-a", "user-1")).toBeGreaterThanOrEqual(0);
  expect(bucketUser("flag-a", "user-1")).toBeLessThan(100);
});

test("rules override percentage rollout and archived flags are off", () => {
  const flag = { key: "new-nav", archived: false, rollout: 0, rules: [{ attr: "country", op: "eq", value: "FR", enabled: true }] };
  expect(evaluateFlag(flag, { id: "u1", country: "FR" })).toBe(true);
  expect(evaluateFlag({ ...flag, archived: true }, { id: "u1", country: "FR" })).toBe(false);
});

test("updates append audit entries", () => {
  const next = updateFlag({ key: "x", rollout: 0, audit: [] }, { rollout: 25 }, "alice");
  expect(next.rollout).toBe(25);
  expect(next.audit.at(-1).actor).toBe("alice");
});
`),

  "rust-tcp-load-balancer-sim": rustFixture("rust-tcp-load-balancer-sim", String.raw`use rust_tcp_load_balancer_sim::{Policy, Simulator};

#[test]
fn health_checks_draining_and_retry_budget_affect_routing() {
    let mut sim = Simulator::new(Policy::LeastConnections);
    sim.add_backend("a");
    sim.add_backend("b");
    sim.mark_unhealthy("a");
    let c1 = sim.accept_connection("client-1", 1).unwrap();
    assert_eq!(c1.backend, "b");
    sim.start_draining("b");
    assert!(sim.accept_connection("client-2", 1).is_err());
    assert_eq!(sim.metrics().failed_connections, 1);
    sim.mark_healthy("a");
    let c2 = sim.accept_connection("client-3", 0).unwrap();
    assert_eq!(c2.backend, "a");
}
`),

  "c-elf-symbol-inspector": cFixture("c-elf-symbol-inspector", String.raw`#pragma once
#include <stddef.h>

typedef struct { size_t exported_count; size_t imported_count; size_t relocation_count; char first_symbol[64]; } ElfSummary;
int elf_inspect_bytes(const unsigned char *data, size_t len, ElfSummary *out);
`, String.raw`#include "solution.h"
#include <assert.h>
#include <string.h>

int main(void) {
    unsigned char bad[8] = {0x7f, 'E', 'L', 'F', 1, 1, 1, 0};
    ElfSummary s;
    assert(elf_inspect_bytes(bad, sizeof bad, &s) != 0);
    unsigned char truncated[4] = {0x7f, 'E', 'L', 'F'};
    assert(elf_inspect_bytes(truncated, sizeof truncated, &s) != 0);
    assert(elf_inspect_bytes(0, 0, &s) != 0);
    return 0;
}
`),

  "ts-sql-migration-planner": tsFixture("ts-sql-migration-planner", String.raw`import { expect, test } from "bun:test";
import { lintMigration, planMigrations } from "../src/index";

test("flags dangerous changes and missing down migrations", () => {
  const diagnostics = lintMigration({ up: "ALTER TABLE users DROP COLUMN email;", down: "" });
  expect(diagnostics.map((d: any) => d.code)).toEqual(expect.arrayContaining(["column.drop", "down.missing"]));
});

test("orders foreign-key dependent tables after parents", () => {
  const plan = planMigrations(["CREATE TABLE orgs (id int primary key);", "CREATE TABLE users (id int primary key, org_id int references orgs(id));"]);
  expect(plan.steps.map((s: any) => s.table)).toEqual(["orgs", "users"]);
});
`),

  "py-timeseries-rollup-engine": pyFixture("py-timeseries-rollup-engine", String.raw`import tempfile, unittest
from solution import TimeSeriesStore, VirtualClock

class TimeseriesContract(unittest.TestCase):
    def test_rollups_late_data_retention_and_recovery(self):
        with tempfile.TemporaryDirectory() as d:
            clock = VirtualClock(100)
            s = TimeSeriesStore(d, clock=clock, windows=[60], retention_seconds=120)
            s.ingest("cpu", {"host": "a"}, ts=10, value=1)
            s.ingest("cpu", {"host": "a"}, ts=59, value=3)
            s.compact()
            self.assertEqual(s.query("cpu", {"host": "a"}, start=0, end=60, agg="avg"), [{"start": 0, "value": 2}])
            clock.advance(200); s.compact()
            self.assertEqual(s.storage_stats()["expired_points"], 2)
            s2 = TimeSeriesStore(d, clock=clock, windows=[60], retention_seconds=120)
            self.assertGreaterEqual(s2.storage_stats()["recovered_files"], 1)

if __name__ == "__main__":
    unittest.main()
`),

  "py-parquetish-column-store": pyFixture("py-parquetish-column-store", String.raw`import os, tempfile, unittest
from solution import ColumnStore, CorruptFileError

class ColumnStoreContract(unittest.TestCase):
    def test_projection_predicate_pushdown_and_checksums(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "events.cstore")
            store = ColumnStore(path)
            store.write([{"user": "a", "kind": "deploy", "cost": 3}, {"user": "b", "kind": "login", "cost": 1}], row_group_size=1)
            rows = store.read(columns=["user"], where=lambda stats, row: stats["kind"].might_contain("deploy") and row.get("kind") == "deploy")
            self.assertEqual(rows, [{"user": "a"}])
            with open(path, "r+b") as f:
                f.seek(-1, os.SEEK_END); f.write(b"x")
            with self.assertRaises(CorruptFileError): ColumnStore(path).metadata()

if __name__ == "__main__":
    unittest.main()
`),

  "c-side-channel-safe-memcmp": cFixture("c-side-channel-safe-memcmp", String.raw`#pragma once
#include <stddef.h>

int ct_equal(const unsigned char *a, const unsigned char *b, size_t len);
unsigned char ct_select_u8(unsigned char when_true, unsigned char when_false, unsigned char mask);
size_t ct_equal_instrumented_steps(const unsigned char *a, const unsigned char *b, size_t len);
`, String.raw`#include "solution.h"
#include <assert.h>

int main(void) {
    unsigned char a[] = {1,2,3,4,5};
    unsigned char b[] = {1,2,9,4,5};
    unsigned char c[] = {1,2,3,4,5};
    assert(ct_equal(a, c, 5) == 1);
    assert(ct_equal(a, b, 5) == 0);
    assert(ct_equal_instrumented_steps(a, b, 5) == 5);
    assert(ct_equal_instrumented_steps(a, c, 5) == 5);
    assert(ct_select_u8(0xAA, 0x55, 0xFF) == 0xAA);
    assert(ct_select_u8(0xAA, 0x55, 0x00) == 0x55);
    return 0;
}
`),

  "rust-service-discovery-gossip-sim": rustFixture("rust-service-discovery-gossip-sim", String.raw`use rust_service_discovery_gossip_sim::{Cluster, NodeState};

#[test]
fn converges_after_partition_heals_and_expires_tombstones() {
    let mut c = Cluster::new_for_tests(3, 42);
    c.join("a"); c.join("b"); c.join("c");
    c.partition(&["a"], &["b", "c"]);
    c.leave("b");
    c.run_rounds(5);
    assert_ne!(c.view("a").get("b"), Some(&NodeState::Left));
    c.heal_all();
    c.run_rounds(20);
    assert_eq!(c.view("a").get("b"), Some(&NodeState::Left));
    c.advance_time(10_000);
    c.expire_tombstones();
    assert!(!c.view("c").contains_key("b"));
}
`),

  "nextjs-log-search-observability": nextFixture("nextjs-log-search-observability", String.raw`import { expect, test } from "bun:test";
import { parseQuery, saveQuery, searchLogs } from "../src/domain";

const logs = [
  { id: "1", ts: 1, severity: "error", service: "api", message: "payment timeout", traceId: "t1" },
  { id: "2", ts: 2, severity: "info", service: "web", message: "ok", traceId: "t2" },
];

test("structured query filters severity, service, and phrase", () => {
  const q = parseQuery('severity:error service:api "payment timeout"');
  expect(searchLogs(logs, q, { pageSize: 10 }).items.map((l: any) => l.id)).toEqual(["1"]);
});

test("pagination and saved queries are stable", () => {
  expect(searchLogs(logs, parseQuery(""), { pageSize: 1, cursor: 1 }).items.map((l: any) => l.id)).toEqual(["2"]);
  expect(saveQuery([], { name: "Errors", query: "severity:error" })[0].id).toBe("errors");
});
`),

  "rust-redis-resp-streaming-parser": rustFixture("rust-redis-resp-streaming-parser", String.raw`use rust_redis_resp_streaming_parser::{encode, RespParser, RespValue};

#[test]
fn parses_fragmented_nested_arrays_and_round_trips() {
    let mut p = RespParser::new();
    assert_eq!(p.feed(b"*2\r\n$4\r\nLL").unwrap(), None);
    let v = p.feed(b"EN\r\n:42\r\n").unwrap().unwrap();
    assert_eq!(v, RespValue::Array(vec![RespValue::BulkString(Some(b"LLEN".to_vec())), RespValue::Integer(42)]));
    assert_eq!(RespParser::parse_one(&encode(&v)).unwrap().0, v);
}

#[test]
fn invalid_lengths_report_offsets() {
    let err = RespParser::parse_one(b"$-2\r\n").unwrap_err();
    assert_eq!(err.offset, 1);
}
`),

  "c-png-chunk-rewriter": cFixture("c-png-chunk-rewriter", String.raw`#pragma once
#include <stddef.h>

typedef struct { char type[5]; unsigned int length; } PngChunk;
int png_list_chunks(const unsigned char *data, size_t len, PngChunk *out, size_t cap, size_t *count);
int png_replace_text(const unsigned char *data, size_t len, const char *key, const char *value, unsigned char *out, size_t out_cap, size_t *out_len);
`, String.raw`#include "solution.h"
#include <assert.h>
#include <string.h>

int main(void) {
    unsigned char not_png[] = {0,1,2,3};
    PngChunk chunks[8]; size_t count = 0;
    assert(png_list_chunks(not_png, sizeof not_png, chunks, 8, &count) != 0);
    unsigned char bad_sig[] = {137,'P','N','G','x','x','x','x'};
    assert(png_list_chunks(bad_sig, sizeof bad_sig, chunks, 8, &count) != 0);
    assert(png_replace_text(not_png, sizeof not_png, "Author", "A", not_png, sizeof not_png, &count) != 0);
    return 0;
}
`),

  "ts-event-sourced-ledger": tsFixture("ts-event-sourced-ledger", String.raw`import { expect, test } from "bun:test";
import { Ledger } from "../src/index";

test("double entry transfers, holds, idempotency, snapshots, and replay", () => {
  const l = new Ledger();
  l.openAccount("cash"); l.openAccount("alice");
  l.transfer({ idempotencyKey: "seed", from: "cash", to: "alice", amount: 1000 });
  l.transfer({ idempotencyKey: "seed", from: "cash", to: "alice", amount: 1000 });
  expect(l.balance("alice")).toBe(1000);
  const hold = l.hold("alice", 400, "order-1");
  expect(() => l.transfer({ from: "alice", to: "cash", amount: 700 })).toThrow();
  l.release(hold.id);
  const snap = l.snapshot();
  const replayed = Ledger.replay(l.events(), snap);
  expect(replayed.balance("alice")).toBe(1000);
  expect(replayed.invariantHolds()).toBe(true);
});
`),

  "py-crdt-document-store": pyFixture("py-crdt-document-store", String.raw`import unittest
from solution import Document

class CrdtDocumentContract(unittest.TestCase):
    def test_concurrent_edits_converge_and_merge_is_idempotent(self):
        a = Document(actor="a")
        b = Document(actor="b")
        a.insert(0, "H"); b.insert(0, "Y")
        a.merge(b.operations()); b.merge(a.operations())
        self.assertEqual(a.text(), b.text())
        before = a.text()
        a.merge(b.operations())
        self.assertEqual(a.text(), before)
        a.delete(0, 1)
        b.merge(a.operations())
        self.assertEqual(a.text(), b.text())
        restored = Document.from_bytes(a.to_bytes())
        self.assertEqual(restored.text(), a.text())

if __name__ == "__main__":
    unittest.main()
`),

  "ts-metrics-alert-router": tsFixture("ts-metrics-alert-router", String.raw`import { expect, test } from "bun:test";
import { AlertRouter, VirtualClock } from "../src/index";

test("thresholds, grouping, silences, inhibition, and escalation are explainable", () => {
  const clock = new VirtualClock(0);
  const r = new AlertRouter({ clock });
  r.addRule({ id: "cpu", metric: "cpu", op: ">", threshold: 90, window: 60, labels: ["service"] });
  r.addRoute({ match: { service: "api" }, receiver: "pager", escalateAfter: 300, escalateTo: "manager" });
  r.ingest({ metric: "cpu", value: 95, labels: { service: "api", instance: "1" }, ts: 10 });
  const fired = r.evaluate();
  expect(fired[0].receiver).toBe("pager");
  expect(fired[0].explain).toContain("cpu");
  r.silence({ service: "api" }, 120);
  expect(r.evaluate()[0].silenced).toBe(true);
});
`),

  "ts-signed-webhook-verifier": tsFixture("ts-signed-webhook-verifier", String.raw`import { expect, test } from "bun:test";
import { signWebhook, WebhookVerifier } from "../src/index";

test("verifies raw-body HMAC, replay, timestamp skew, and rotation", () => {
  const now = 1_700_000_000;
  const body = Buffer.from('{"a":1}\n');
  const header = signWebhook({ body, secret: "new", timestamp: now, id: "evt1", version: "v1" });
  const verifier = new WebhookVerifier({ secrets: ["old", "new"], now: () => now, toleranceSeconds: 300 });
  expect(verifier.verify({ body, signatureHeader: header }).eventId).toBe("evt1");
  expect(() => verifier.verify({ body, signatureHeader: header })).toThrow(/replay/i);
  expect(() => verifier.verify({ body: Buffer.from('{"a":1}'), signatureHeader: header })).toThrow(/signature/i);
});
`),

  "c-log-structured-filesystem-sim": cFixture("c-log-structured-filesystem-sim", String.raw`#pragma once
#include <stddef.h>

typedef struct Lfs Lfs;
Lfs *lfs_create(size_t block_count, size_t block_size);
void lfs_destroy(Lfs *fs);
int lfs_write(Lfs *fs, const char *path, const unsigned char *data, size_t len);
int lfs_read(Lfs *fs, const char *path, unsigned char *out, size_t cap, size_t *len);
int lfs_checkpoint(Lfs *fs);
int lfs_crash_recover(Lfs *fs);
int lfs_delete(Lfs *fs, const char *path);
`, String.raw`#include "solution.h"
#include <assert.h>
#include <string.h>

int main(void) {
    Lfs *fs = lfs_create(64, 128);
    assert(fs);
    assert(lfs_write(fs, "/etc/config", (const unsigned char *)"v1", 2) == 0);
    assert(lfs_checkpoint(fs) == 0);
    assert(lfs_write(fs, "/etc/config", (const unsigned char *)"v2", 2) == 0);
    assert(lfs_crash_recover(fs) == 0);
    unsigned char buf[16]; size_t len = 0;
    assert(lfs_read(fs, "/etc/config", buf, sizeof buf, &len) == 0);
    assert(len == 2 && memcmp(buf, "v1", 2) == 0);
    assert(lfs_delete(fs, "/etc/config") == 0);
    lfs_destroy(fs);
    return 0;
}
`),

  "nextjs-offline-field-service": nextFixture("nextjs-offline-field-service", String.raw`import { expect, test } from "bun:test";
import { createOfflineQueue, detectConflict, enqueueMutation, resolveConflict } from "../src/domain";

test("queued mutations keep order and sync metadata", () => {
  let q = createOfflineQueue();
  q = enqueueMutation(q, { id: "m1", type: "check", workOrderId: "wo1", payload: { step: "safety" } });
  q = enqueueMutation(q, { id: "m2", type: "note", workOrderId: "wo1", payload: { text: "done" } });
  expect(q.pending.map((m: any) => m.id)).toEqual(["m1", "m2"]);
});

test("conflicts are detected and resolvable", () => {
  const conflict = detectConflict({ version: 2, fields: { status: "open" } }, { baseVersion: 1, fields: { status: "done" } });
  expect(conflict.conflictedFields).toEqual(["status"]);
  expect(resolveConflict(conflict, "local").fields.status).toBe("done");
});
`),

  "rust-merkle-log-auditor": rustFixture("rust-merkle-log-auditor", String.raw`use rust_merkle_log_auditor::MerkleLog;

#[test]
fn inclusion_and_consistency_proofs_verify_and_tampering_fails() {
    let mut log = MerkleLog::new();
    log.append(b"a"); log.append(b"b"); log.append(b"c");
    let root3 = log.root();
    let p = log.inclusion_proof(1).unwrap();
    assert!(MerkleLog::verify_inclusion(root3, b"b", 1, 3, &p).unwrap());
    assert!(!MerkleLog::verify_inclusion(root3, b"x", 1, 3, &p).unwrap());
    let root2 = log.root_at_size(2).unwrap();
    let cp = log.consistency_proof(2, 3).unwrap();
    assert!(MerkleLog::verify_consistency(root2, root3, 2, 3, &cp).unwrap());
}
`),

  "c-wal-recovery": cFixture("c-wal-recovery", String.raw`#pragma once
#include <stddef.h>

typedef struct Wal Wal;
typedef int (*wal_replay_cb)(unsigned type, const unsigned char *payload, size_t len, void *user);
Wal *wal_open(const char *path);
void wal_close(Wal *wal);
int wal_append(Wal *wal, unsigned type, const unsigned char *payload, size_t len);
int wal_flush(Wal *wal);
int wal_replay(const char *path, wal_replay_cb cb, void *user);
int wal_truncate_torn_tail(const char *path);
`, String.raw`#include "solution.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static int count_cb(unsigned type, const unsigned char *payload, size_t len, void *user) {
    int *n = (int *)user;
    assert(type == 7);
    assert(len == 3 && memcmp(payload, "abc", 3) == 0);
    (*n)++;
    return 0;
}

int main(void) {
    const char *path = "build/test.wal";
    Wal *w = wal_open(path);
    assert(w);
    assert(wal_append(w, 7, (const unsigned char *)"abc", 3) == 0);
    assert(wal_flush(w) == 0);
    wal_close(w);
    FILE *f = fopen(path, "ab"); assert(f); fputs("torn", f); fclose(f);
    assert(wal_truncate_torn_tail(path) == 0);
    int n = 0; assert(wal_replay(path, count_cb, &n) == 0); assert(n == 1);
    return 0;
}
`),

  "ts-graphql-cache-normalizer": tsFixture("ts-graphql-cache-normalizer", String.raw`import { expect, test } from "bun:test";
import { Cache } from "../src/index";

test("normalizes entities, optimistic layers, invalidation, and denormalization misses", () => {
  const cache = new Cache();
  cache.writeQuery({ field: "viewer" }, { __typename: "User", id: "u1", name: "Ada", org: { __typename: "Org", id: "o1", name: "Ops" } });
  expect(cache.entity("User:u1").org.__ref).toBe("Org:o1");
  cache.optimistic("m1", (draft: any) => draft.writeEntity("User:u1", { name: "Grace" }));
  expect(cache.readQuery({ field: "viewer" }).name).toBe("Grace");
  cache.rollback("m1");
  cache.invalidate("Org:o1");
  expect(cache.readQuery({ field: "viewer" }).org).toEqual({ missing: "Org:o1" });
});
`),

  "py-sat-scheduler": pyFixture("py-sat-scheduler", String.raw`import unittest
from solution import Scheduler, UnsatError

class SatSchedulerContract(unittest.TestCase):
    def test_schedules_with_precedence_capacity_and_unsat_explanation(self):
        s = Scheduler(resources={"gpu": 1}, slots=range(4))
        s.add_job("prep", duration=1)
        s.add_job("train", duration=2, resources={"gpu": 1}, after=["prep"])
        plan = s.solve()
        self.assertLess(plan["prep"].end, plan["train"].start + 1)
        impossible = Scheduler(resources={"gpu": 0}, slots=range(1))
        impossible.add_job("x", duration=1, resources={"gpu": 1})
        with self.assertRaises(UnsatError) as cm: impossible.solve()
        self.assertIn("gpu", str(cm.exception))

if __name__ == "__main__":
    unittest.main()
`),

  "py-incremental-backup-deduper": pyFixture("py-incremental-backup-deduper", String.raw`import os, tempfile, unittest
from solution import BackupStore, IntegrityError

class BackupDeduperContract(unittest.TestCase):
    def test_snapshots_dedupe_restore_prune_and_verify(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src"); os.mkdir(src)
            open(os.path.join(src, "a.txt"), "wb").write(b"hello" * 100)
            store = BackupStore(os.path.join(d, "store"), chunk_size=32)
            s1 = store.snapshot(src)
            open(os.path.join(src, "b.txt"), "wb").write(b"hello" * 100)
            s2 = store.snapshot(src)
            self.assertLess(store.stats()["unique_chunks"], store.stats()["referenced_chunks"])
            restore = os.path.join(d, "restore"); store.restore(s2, restore)
            self.assertTrue(os.path.exists(os.path.join(restore, "b.txt")))
            store.prune(keep=[s2]); store.verify()
            chunk = next(iter(store.chunk_paths()))
            open(chunk, "wb").write(b"bad")
            with self.assertRaises(IntegrityError): store.verify()

if __name__ == "__main__":
    unittest.main()
`),

  "rust-sparse-nullifier-set": rustFixture("rust-sparse-nullifier-set", String.raw`use rust_sparse_nullifier_set::NullifierSet;

#[test]
fn membership_non_membership_and_duplicate_rejection() {
    let mut set = NullifierSet::new(8);
    let empty_root = set.root();
    let non = set.non_membership_proof([0u8; 32]).unwrap();
    assert!(NullifierSet::verify_non_membership(empty_root, [0u8; 32], &non).unwrap());
    set.insert([1u8; 32]).unwrap();
    let root = set.root();
    assert!(set.insert([1u8; 32]).is_err());
    let proof = set.membership_proof([1u8; 32]).unwrap();
    assert!(NullifierSet::verify_membership(root, [1u8; 32], &proof).unwrap());
    assert!(!NullifierSet::verify_membership(root, [2u8; 32], &proof).unwrap());
}
`),

  "py-rate-limited-task-runner": pyFixture("py-rate-limited-task-runner", String.raw`import unittest
from solution import TaskRunner, VirtualClock

class RateLimitedRunnerContract(unittest.TestCase):
    def test_fairness_rate_limits_retries_and_deadlines(self):
        clock = VirtualClock(0)
        r = TaskRunner(clock=clock, tenant_limits={"a": 1, "b": 1}, workers=1)
        r.submit("a1", tenant="a", priority=1, deadline=10)
        r.submit("a2", tenant="a", priority=1, deadline=10)
        r.submit("b1", tenant="b", priority=1, deadline=10)
        self.assertEqual(r.tick()[0].id, "a1")
        self.assertEqual(r.tick()[0].id, "b1")
        clock.advance(1)
        self.assertEqual(r.tick()[0].id, "a2")
        r.fail("a2", retry_after=5)
        self.assertIn("retry", r.trace("a2").lower())

if __name__ == "__main__":
    unittest.main()
`),

  "nextjs-ai-workbench-mock": nextFixture("nextjs-ai-workbench-mock", String.raw`import { expect, test } from "bun:test";
import { compareRuns, detectRegressions, scoreRun } from "../src/domain";

test("scores rubric items and computes explainable deltas", () => {
  const run = scoreRun([{ id: "case1", expected: "yes", actual: "yes" }, { id: "case2", expected: "safe", actual: "unsafe" }], [{ name: "exact", weight: 2 }]);
  expect(run.totalScore).toBeGreaterThan(0);
  const diff = compareRuns({ id: "old", scores: { case1: 1, case2: 1 } }, { id: "new", scores: { case1: 1, case2: 0.2 } });
  expect(diff.deltas.case2).toBeLessThan(0);
  expect(detectRegressions(diff, { threshold: -0.5 }).map((r: any) => r.caseId)).toEqual(["case2"]);
});
`),

  "rust-mpsc-ring-buffer": rustFixture("rust-mpsc-ring-buffer", String.raw`use rust_mpsc_ring_buffer::{bounded, TrySendError};
use std::thread;

#[test]
fn preserves_per_producer_order_backpressure_and_close() {
    let (tx, rx) = bounded(2);
    tx.try_send(1).unwrap();
    tx.try_send(2).unwrap();
    assert!(matches!(tx.try_send(3), Err(TrySendError::Full(3))));
    assert_eq!(rx.recv().unwrap(), 1);
    let tx2 = tx.clone();
    let h = thread::spawn(move || { tx2.send(3).unwrap(); });
    assert_eq!(rx.recv().unwrap(), 2);
    h.join().unwrap();
    assert_eq!(rx.recv().unwrap(), 3);
    tx.close();
    assert!(rx.recv().is_err());
}
`),

  "c-http-parser-fuzzer": cFixture("c-http-parser-fuzzer", String.raw`#pragma once
#include <stddef.h>

typedef struct HttpParser HttpParser;
typedef struct { char method[16]; char path[128]; size_t content_length; int keep_alive; } HttpRequest;
HttpParser *http_parser_new(void);
void http_parser_free(HttpParser *p);
int http_parser_execute(HttpParser *p, const char *buf, size_t len, HttpRequest *out);
void http_parser_reset(HttpParser *p);
`, String.raw`#include "solution.h"
#include <assert.h>
#include <string.h>

int main(void) {
    HttpParser *p = http_parser_new(); assert(p);
    HttpRequest r;
    assert(http_parser_execute(p, "GET /", 5, &r) == 0);
    assert(http_parser_execute(p, "x HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\n\r\n", 47, &r) == 1);
    assert(strcmp(r.method, "GET") == 0 && strcmp(r.path, "/x") == 0);
    http_parser_reset(p);
    assert(http_parser_execute(p, "GET / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\n", 69, &r) < 0);
    http_parser_free(p);
    return 0;
}
`),

  "ts-dependency-license-auditor": tsFixture("ts-dependency-license-auditor", String.raw`import { expect, test } from "bun:test";
import { auditLicenses } from "../src/index";

test("finds transitive denied and unknown licenses with stable reports", () => {
  const report = auditLicenses({ root: { dependencies: { a: "1.0.0" } }, packages: { "a@1.0.0": { license: "MIT", dependencies: { b: "1.0.0" } }, "b@1.0.0": { license: "GPL-3.0" }, "c@1.0.0": {} } }, { denied: ["GPL-3.0"], unknown: "warn" });
  expect(report.violations.map((v: any) => v.package)).toContain("b@1.0.0");
  expect(report.markdown).toContain("GPL-3.0");
  expect(JSON.stringify(report.json)).toContain("violations");
});
`),

  "py-lsm-compaction-simulator": pyFixture("py-lsm-compaction-simulator", String.raw`import unittest
from solution import LsmSimulator

class LsmCompactionContract(unittest.TestCase):
    def test_tombstones_snapshots_and_deterministic_compaction_metrics(self):
        sim = LsmSimulator(memtable_limit=2, policy="leveled")
        sim.put("a", "1"); sim.put("b", "2")
        snap = sim.snapshot()
        sim.delete("a"); sim.put("c", "3")
        decisions = sim.compact()
        self.assertEqual(sim.get("a", snapshot=snap), "1")
        self.assertIsNone(sim.get("a"))
        self.assertEqual(decisions, sim.last_compaction_explanation()["decisions"])
        self.assertGreaterEqual(sim.metrics()["read_amplification"], 1)

if __name__ == "__main__":
    unittest.main()
`),

  "ts-local-first-sync-engine": tsFixture("ts-local-first-sync-engine", String.raw`import { expect, test } from "bun:test";
import { Client, Server, UnreliableTransport } from "../src/index";

test("converges with duplicate/reordered messages and exposes conflicts", () => {
  const server = new Server();
  const transport = new UnreliableTransport({ duplicate: true, reorder: true });
  const a = new Client("a", transport, server);
  const b = new Client("b", transport, server);
  a.put("doc", { title: "local" });
  b.put("doc", { title: "remote" });
  transport.flushAll();
  a.sync(); b.sync(); transport.flushAll(); a.sync(); b.sync();
  expect(a.get("doc")).toEqual(b.get("doc"));
  expect(a.conflicts("doc").length).toBeGreaterThanOrEqual(1);
  const checkpoint = a.checkpoint();
  a.compact();
  expect(a.resumeFrom(checkpoint).ok).toBe(true);
});
`),

  "py-supply-chain-manifest-verifier": pyFixture("py-supply-chain-manifest-verifier", String.raw`import hashlib, json, os, tempfile, unittest
from solution import ManifestVerifier

class ManifestVerifierContract(unittest.TestCase):
    def test_digest_path_traversal_duplicate_and_rollback_checks(self):
        with tempfile.TemporaryDirectory() as d:
            artifact = os.path.join(d, "app.bin"); open(artifact, "wb").write(b"abc")
            digest = hashlib.sha256(b"abc").hexdigest()
            m = {"version": 2, "signer": "builder", "artifacts": [{"path": "app.bin", "size": 3, "sha256": digest}], "signature": "fixture-valid"}
            v = ManifestVerifier(trusted_signers={"builder"}, min_version=1)
            self.assertTrue(v.verify(d, m).ok)
            bad = dict(m); bad["artifacts"] = m["artifacts"] + [{"path": "../evil", "size": 0, "sha256": digest}]
            self.assertFalse(v.verify(d, bad).ok)
            old = dict(m); old["version"] = 0
            self.assertIn("rollback", v.verify(d, old).summary.lower())

if __name__ == "__main__":
    unittest.main()
`),

  "ts-release-train-orchestrator": tsFixture("ts-release-train-orchestrator", String.raw`import { expect, test } from "bun:test";
import { ReleaseTrain } from "../src/index";

test("blocks on dependency gates, freeze windows, canary failure, and records audit", () => {
  const train = new ReleaseTrain({ now: () => new Date("2026-05-14T10:00:00Z") });
  train.addService({ name: "api", version: "1.2.0", dependsOn: ["db"] });
  train.addService({ name: "db", version: "4.0.0" });
  train.addFreezeWindow({ start: "2026-05-14T09:00:00Z", end: "2026-05-14T11:00:00Z" });
  const dry = train.plan({ services: ["api"], dryRun: true });
  expect(dry.blockedReasons.map((r: any) => r.code)).toContain("freeze.window");
  train.clearFreezeWindows(); train.approve("db", "lead"); train.approve("api", "lead");
  train.recordCanary("api", { ok: false, reason: "5xx" });
  expect(train.plan({ services: ["api"] }).rollbackPlan).toBeDefined();
  expect(train.auditLog().length).toBeGreaterThan(0);
});
`),

  "nextjs-security-review-tracker": nextFixture("nextjs-security-review-tracker", String.raw`import { expect, test } from "bun:test";
import { calculateSla, filterFindings, transitionFinding } from "../src/domain";

test("SLA calculations account for severity and breach", () => {
  expect(calculateSla({ severity: "critical", openedAt: "2026-01-01T00:00:00Z" }, new Date("2026-01-03T00:00:01Z")).breached).toBe(true);
});

test("invalid transitions are rejected and valid ones audit", () => {
  expect(() => transitionFinding({ id: "f1", status: "closed", audit: [] }, "triaged", "alice")).toThrow();
  const f = transitionFinding({ id: "f1", status: "open", audit: [] }, "triaged", "bob");
  expect(f.audit.at(-1).actor).toBe("bob");
});

test("filters by team/severity/SLA", () => {
  const out = filterFindings([{ id: "a", team: "platform", severity: "high", slaBreached: true }, { id: "b", team: "ml", severity: "low", slaBreached: false }], { team: "platform", slaBreached: true });
  expect(out.map((f: any) => f.id)).toEqual(["a"]);
});
`),

  "rust-container-layer-diff": rustFixture("rust-container-layer-diff", String.raw`use rust_container_layer_diff::{apply_layers, LayerEntry};

#[test]
fn applies_whiteouts_opaque_dirs_and_rejects_traversal() {
    let layers = vec![
        vec![LayerEntry::file("/app/a.txt", b"one"), LayerEntry::file("/app/b.txt", b"same")],
        vec![LayerEntry::whiteout("/app/a.txt"), LayerEntry::file("/app/c.txt", b"same")],
    ];
    let view = apply_layers(layers).unwrap();
    assert!(!view.files.contains_key("/app/a.txt"));
    assert!(view.files.contains_key("/app/c.txt"));
    assert_eq!(view.duplicate_content_groups().len(), 1);
    assert!(apply_layers(vec![vec![LayerEntry::file("/../evil", b"x")]]).is_err());
}
`),

  "c-threadpool-workstealing": cFixture("c-threadpool-workstealing", String.raw`#pragma once
#include <stddef.h>

typedef struct ThreadPool ThreadPool;
typedef struct Future Future;
typedef int (*TaskFn)(void *arg);
ThreadPool *pool_create(size_t workers);
void pool_destroy(ThreadPool *pool);
Future *pool_submit(ThreadPool *pool, TaskFn fn, void *arg);
int future_get(Future *future, int *out);
int future_cancel(Future *future);
`, String.raw`#include "solution.h"
#include <assert.h>

static int add_one(void *arg) { return *(int *)arg + 1; }
static int nested(void *arg) {
    ThreadPool *p = (ThreadPool *)arg;
    int v = 41; Future *f = pool_submit(p, add_one, &v);
    int out = 0; assert(future_get(f, &out) == 0);
    return out;
}

int main(void) {
    ThreadPool *p = pool_create(2); assert(p);
    int v = 1; Future *f = pool_submit(p, add_one, &v);
    int out = 0; assert(future_get(f, &out) == 0 && out == 2);
    Future *n = pool_submit(p, nested, p);
    assert(future_get(n, &out) == 0 && out == 42);
    pool_destroy(p);
    return 0;
}
`),

  "ts-cron-workflow-engine": tsFixture("ts-cron-workflow-engine", String.raw`import { expect, test } from "bun:test";
import { VirtualClock, WorkflowEngine } from "../src/index";

test("catch-up, DAG ordering, retry budgets, cancellation, and idempotency", () => {
  const clock = new VirtualClock("2026-01-01T00:00:00Z");
  const e = new WorkflowEngine({ clock });
  e.define({ id: "daily", cron: "0 0 * * *", catchUp: 2, jobs: [{ id: "extract" }, { id: "load", after: ["extract"], retries: 2 }] });
  clock.advanceDays(3);
  const runs = e.tick();
  expect(runs).toHaveLength(2);
  expect(e.jobsForRun(runs[0].id).map((j: any) => j.id)).toEqual(["extract", "load"]);
  e.failJob(runs[0].id, "load"); e.retryDue();
  expect(e.job(runs[0].id, "load").attempts).toBe(2);
  e.cancel(runs[1].id);
  expect(e.tick()).toHaveLength(0);
});
`),

  "py-consensus-raft-simulator": pyFixture("py-consensus-raft-simulator", String.raw`import unittest
from solution import RaftCluster

class RaftSimulatorContract(unittest.TestCase):
    def test_election_partition_healing_and_log_safety(self):
        c = RaftCluster.node_ids(["a", "b", "c"], seed=7)
        c.run_until_leader()
        leader = c.leader()
        c.client_append("x=1")
        c.partition([leader], [n for n in c.node_ids if n != leader])
        c.tick(10)
        c.heal()
        c.run_until_leader()
        c.client_append("x=2")
        c.tick(20)
        committed = [tuple(n.committed_entries()) for n in c.nodes]
        self.assertEqual(len(set(committed)), 1)
        c.crash(c.leader()); c.restart(c.leader())
        self.assertTrue(c.safety_invariants_hold())

if __name__ == "__main__":
    unittest.main()
`),

  "py-email-ingestion-pipeline": pyFixture("py-email-ingestion-pipeline", String.raw`import unittest
from solution import EmailPipeline

RAW = b"From: Alice <a@example.com>\r\nMessage-ID: <m1>\r\nSubject: Hi\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nhello\r\n--x\r\nContent-Disposition: attachment; filename=a.txt\r\nContent-Type: text/plain\r\n\r\nlarge-data\r\n--x--\r\n"

class EmailPipelineContract(unittest.TestCase):
    def test_mime_attachment_dedupe_quarantine_and_json_stability(self):
        p = EmailPipeline(quarantine_domains={"evil.test"})
        rec = p.ingest(RAW)
        self.assertEqual(rec.sender_domain, "example.com")
        self.assertEqual(rec.attachments[0].filename, "a.txt")
        self.assertEqual(p.ingest(RAW).duplicate_of, "<m1>")
        bad = b"From: Mallory <m@evil.test>\r\nMessage-ID: <m2>\r\n\r\nx"
        self.assertTrue(p.ingest(bad).quarantined)
        self.assertIn('"message_id":"<m1>"', rec.to_json())

if __name__ == "__main__":
    unittest.main()
`),

  "c-secure-tar-extractor": cFixture("c-secure-tar-extractor", String.raw`#pragma once
#include <stddef.h>

typedef struct { size_t files; size_t dirs; size_t rejected; } TarSummary;
int tar_validate_archive(const unsigned char *data, size_t len, TarSummary *out);
int tar_extract_archive(const unsigned char *data, size_t len, const char *dest, TarSummary *out);
`, String.raw`#include "solution.h"
#include <assert.h>
#include <string.h>

int main(void) {
    unsigned char empty[1024] = {0};
    TarSummary s;
    assert(tar_validate_archive(empty, sizeof empty, &s) == 0);
    assert(s.files == 0);
    unsigned char bad[512] = {0};
    memcpy(bad, "../evil", 7);
    memcpy(bad + 257, "ustar", 5);
    assert(tar_validate_archive(bad, sizeof bad, &s) != 0);
    assert(tar_extract_archive(bad, sizeof bad, "build/out", &s) != 0);
    return 0;
}
`),

  "rust-priority-retry-queue": rustFixture("rust-priority-retry-queue", String.raw`use rust_priority_retry_queue::Queue;
use std::time::{SystemTime, UNIX_EPOCH};

fn tmpdir() -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("catallaxy_prioq_{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir_all(&p).unwrap();
    p
}

#[test]
fn priority_delay_lease_retry_dead_letter_and_recovery() {
    let dir = tmpdir();
    let mut q = Queue::open(&dir).unwrap();
    q.enqueue("low", 1, 0, b"a".to_vec()).unwrap();
    q.enqueue("high", 10, 5, b"b".to_vec()).unwrap();
    assert_eq!(q.lease(0, 30).unwrap().id, "low");
    assert_eq!(q.lease(5, 30).unwrap().id, "high");
    q.retry("high", 6).unwrap();
    q.fail_permanently("high", "boom").unwrap();
    drop(q);
    let q = Queue::open(&dir).unwrap();
    assert_eq!(q.metrics().dead_letters, 1);
}
`),

  "nextjs-data-room": nextFixture("nextjs-data-room", String.raw`import { expect, test } from "bun:test";
import { canAccessDocument, recordActivity, resolvePermission } from "../src/domain";

test("permission inheritance and explicit denies are enforced", () => {
  const tree = { docs: { root: { parent: null }, secret: { parent: "root" } }, grants: [{ subject: "group:buyers", doc: "root", action: "view" }, { subject: "user:alice", doc: "secret", action: "deny" }] };
  expect(resolvePermission(tree, { user: "bob", groups: ["buyers"] }, "secret")).toBe("view");
  expect(canAccessDocument(tree, { user: "alice", groups: ["buyers"] }, "secret")).toBe(false);
});

test("activity timeline is stable and actor-scoped", () => {
  const timeline = recordActivity([], { actor: "alice", doc: "secret", action: "request_access", at: "2026-01-01T00:00:00Z" });
  expect(timeline[0].actor).toBe("alice");
});
`),

  "rust-bytecode-vm": rustFixture("rust-bytecode-vm", String.raw`use rust_bytecode_vm::{Assembler, Trap, Vm};

#[test]
fn assembles_executes_traces_and_traps_on_gas_or_bounds() {
    let program = Assembler::assemble("push 2\npush 40\nadd\nstore 0\nload 0\nhalt\n").unwrap();
    let mut vm = Vm::new(program).with_gas(20).with_memory(8);
    let result = vm.run().unwrap();
    assert_eq!(result.stack, vec![42]);
    assert!(result.trace.iter().any(|s| s.pc == 2));
    let bad = Assembler::assemble("load 99\nhalt\n").unwrap();
    assert!(matches!(Vm::new(bad).with_memory(1).run().unwrap_err(), Trap::MemoryOutOfBounds { .. }));
    let looped = Assembler::assemble("start: jump start\n").unwrap();
    assert!(matches!(Vm::new(looped).with_gas(3).run().unwrap_err(), Trap::OutOfGas));
}
`),

  "c-page-table-simulator": cFixture("c-page-table-simulator", String.raw`#pragma once
#include <stdint.h>

typedef struct PageTable PageTable;
typedef enum { PT_OK = 0, PT_NOT_PRESENT, PT_PERMISSION, PT_NON_CANONICAL } PtStatus;
PageTable *pt_create(void);
void pt_destroy(PageTable *pt);
int pt_map(PageTable *pt, uint64_t virt, uint64_t phys, uint64_t flags);
PtStatus pt_translate(PageTable *pt, uint64_t virt, uint64_t access, uint64_t *phys_out);
int pt_unmap(PageTable *pt, uint64_t virt);
int pt_protect(PageTable *pt, uint64_t virt, uint64_t flags);
void pt_invalidate_tlb(PageTable *pt, uint64_t virt);
`, String.raw`#include "solution.h"
#include <assert.h>

int main(void) {
    PageTable *pt = pt_create(); assert(pt);
    assert(pt_map(pt, 0x4000, 0x2000, 0x3) == 0);
    uint64_t phys = 0;
    assert(pt_translate(pt, 0x4000, 1, &phys) == PT_OK && phys == 0x2000);
    assert(pt_protect(pt, 0x4000, 0x1) == 0);
    pt_invalidate_tlb(pt, 0x4000);
    assert(pt_translate(pt, 0x4000, 2, &phys) == PT_PERMISSION);
    assert(pt_translate(pt, 0xffff000000000000ULL, 1, &phys) == PT_NON_CANONICAL);
    assert(pt_unmap(pt, 0x4000) == 0);
    assert(pt_translate(pt, 0x4000, 1, &phys) == PT_NOT_PRESENT);
    pt_destroy(pt);
    return 0;
}
`),

  "ts-binary-protocol-codegen": tsFixture("ts-binary-protocol-codegen", String.raw`import { expect, test } from "bun:test";
import { checkCompatibility, decodeMessage, encodeMessage, parseIdl } from "../src/index";

test("IDL parsing, generated round trips, malformed buffers, and versioning", () => {
  const schema = parseIdl("message User v1 { id: varint; name: bytes; active: bool = 3; }");
  const buf = encodeMessage(schema, "User", { id: 7, name: new Uint8Array([65]), active: true });
  expect(decodeMessage(schema, "User", buf)).toEqual({ id: 7, name: new Uint8Array([65]), active: true });
  expect(() => decodeMessage(schema, "User", new Uint8Array([255]))).toThrow();
  const next = parseIdl("message User v2 { id: varint; name: bytes; active: bool = 3; email: bytes = 4 optional; }");
  expect(checkCompatibility(schema, next).compatible).toBe(true);
});
`),

  "py-log-anomaly-detector": pyFixture("py-log-anomaly-detector", String.raw`import tempfile, unittest
from solution import AnomalyDetector

class LogAnomalyContract(unittest.TestCase):
    def test_templates_baseline_spikes_novel_and_snapshot(self):
        d = AnomalyDetector(threshold=3)
        for _ in range(10): d.ingest("INFO user 123 logged in")
        self.assertFalse(d.ingest("INFO user 456 logged in").alerts)
        alert = d.ingest("ERROR payment gateway timeout").alerts[0]
        self.assertEqual(alert.kind, "novel_template")
        with tempfile.TemporaryDirectory() as path:
            d.save(path)
            e = AnomalyDetector.load(path)
            self.assertEqual(e.template_count("INFO user * logged in"), 11)

if __name__ == "__main__":
    unittest.main()
`),

  "ts-permission-policy-engine": tsFixture("ts-permission-policy-engine", String.raw`import { expect, test } from "bun:test";
import { PolicyEngine } from "../src/index";

test("role inheritance, explicit deny, conditions, batching, and explanations", () => {
  const e = PolicyEngine.parse("role admin inherits editor\nallow editor document:read if resource.team == subject.team\ndeny user:bob document:read");
  expect(e.authorize({ subject: { id: "alice", roles: ["admin"], team: "ops" }, resource: { type: "document", team: "ops" }, action: "read" }).allowed).toBe(true);
  const denied = e.authorize({ subject: { id: "bob", roles: ["admin"], team: "ops" }, resource: { type: "document", team: "ops" }, action: "read" });
  expect(denied.allowed).toBe(false);
  expect(denied.explain).toContain("explicit deny");
  expect(e.authorizeBatch([{ subject: { id: "alice", roles: ["admin"], team: "ops" }, resource: { type: "document", team: "ml" }, action: "read" }])[0].allowed).toBe(false);
});
`),

  "ts-oauth-device-flow-simulator": tsFixture("ts-oauth-device-flow-simulator", String.raw`import { expect, test } from "bun:test";
import { DeviceFlowServer, VirtualClock } from "../src/index";

test("device polling pending slow_down approval expiry and revocation", () => {
  const clock = new VirtualClock(0);
  const s = new DeviceFlowServer({ clock, clients: ["cli"], interval: 5 });
  const flow = s.start({ clientId: "cli", scopes: ["read"] });
  expect(s.poll(flow.deviceCode).error).toBe("authorization_pending");
  expect(s.poll(flow.deviceCode).error).toBe("slow_down");
  s.approve(flow.userCode, "alice");
  clock.advance(5);
  const token = s.poll(flow.deviceCode).accessToken;
  expect(token).toBeTruthy();
  s.revoke(token);
  expect(s.introspect(token).active).toBe(false);
});
`),

  "py-chaos-proxy-simulator": pyFixture("py-chaos-proxy-simulator", String.raw`import unittest
from solution import ChaosProxy, VirtualClock

class ChaosProxyContract(unittest.TestCase):
    def test_latency_drop_reorder_duplicate_bandwidth_and_metrics_are_deterministic(self):
        clock = VirtualClock(0)
        p = ChaosProxy(clock=clock, seed=123, latency_ms=10, duplicate_every=2, bandwidth_bytes_per_sec=10)
        p.send("flow", b"abc")
        p.send("flow", b"def")
        self.assertEqual(p.recv("flow"), None)
        clock.advance_ms(1000)
        out = []
        while True:
            msg = p.recv("flow")
            if msg is None: break
            out.append(msg)
        self.assertIn(b"abc", out)
        self.assertGreaterEqual(p.metrics()["flow"]["duplicated"], 1)
        p.partition("a", "b")
        self.assertTrue(p.is_partitioned("a", "b"))

if __name__ == "__main__":
    unittest.main()
`),
};

export const PRETRAIN_FIXTURE_SLUGS = Object.freeze(Object.keys(FIXTURES).sort());

function isProtectedFixturePath(path: string): boolean {
  return path.startsWith("tests/")
    || path === "package.json"
    || path === "tsconfig.json"
    || path === "next.config.ts"
    || path === "Cargo.toml"
    || path === "Makefile"
    || path === "src/solution.h";
}

export function pretrainFixtureProtectedPaths(slug: string): string[] {
  const fixture = FIXTURES[slug];
  if (!fixture) throw new Error(`unknown pretrain fixture: ${slug}`);
  return Object.keys(fixture.files)
    .filter(isProtectedFixturePath)
    .sort()
    .map((path) => `pretrain/${slug}/${path}`);
}

async function writeFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, content);
}

async function git(args: string[], allowExit: number[] = [0]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", "-C", PLAYGROUND, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  if (!allowExit.includes(code)) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  return { code, stdout, stderr };
}

export async function ensurePretrainFixtures(tasks: readonly PretrainTaskTemplate[]): Promise<void> {
  const missing = tasks.map((t) => t.slug).filter((slug) => !FIXTURES[slug]);
  if (missing.length) throw new Error(`missing pretrain fixture(s): ${missing.join(", ")}`);

  await rm(join(PLAYGROUND, "pretrain"), { recursive: true, force: true });
  for (const task of tasks) {
    const fixture = FIXTURES[task.slug];
    for (const [rel, content] of Object.entries(fixture.files)) {
      await writeFile(join(PLAYGROUND, "pretrain", task.slug, rel), content);
    }
  }

  await git(["add", "-A", "pretrain"]);
  const diff = await git(["diff", "--cached", "--quiet", "--", "pretrain"], [0, 1]);
  if (diff.code === 1) {
    await git(["-c", "user.name=Catallaxy", "-c", "user.email=catallaxy@example.invalid", "commit", "-m", "Seed pretrain acceptance tests", "--", "pretrain"]);
  }
}
