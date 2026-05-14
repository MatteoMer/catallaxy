export interface PretrainTaskTemplate {
  slug: string;
  title: string;
  domain: string;
  reservation: number;
  reviewFee: number;
  check: string;
  description: string;
  subjectiveCriteria: string;
}

interface TaskSpec {
  slug: string;
  title: string;
  domain: string;
  reservation: number;
  check: string;
  requirements: string[];
  criteria?: string[];
  reviewFee?: number;
}

export const MIN_PRETRAIN_RESERVATION = 5_000_000;
export const DEFAULT_PRETRAIN_TASKS_PER_AGENT = 8;
export const DEFAULT_PRETRAIN_MAX_ITERS = 6;
export const DEFAULT_PRETRAIN_REVIEW_FEE = 50_000;

function tokens(n: number): string {
  return n.toLocaleString("en-US");
}

function makeTask(spec: TaskSpec): PretrainTaskTemplate {
  if (!Number.isInteger(spec.reservation) || spec.reservation < MIN_PRETRAIN_RESERVATION) {
    throw new Error(`${spec.slug}: reservation must be >= ${MIN_PRETRAIN_RESERVATION}`);
  }
  const dir = `pretrain/${spec.slug}`;
  const description = [
    `[pretrain:${spec.slug}] ${spec.title}.`,
    "",
    `Build this as a production-grade, real-life task under \`${dir}/\`. The existing repository may contain unrelated stale files from other experiments; do not depend on them and do not modify them unless the task explicitly requires it.`,
    `Reservation price: ${tokens(spec.reservation)} tokens. This is intentionally high; bid only if you can complete the whole task profitably after thinking + review costs.`,
    "",
    "Requirements:",
    ...spec.requirements.map((r, i) => `${i + 1}. ${r}`),
    "",
    `Deterministic acceptance check, run from the repository root: \`${spec.check}\``,
    "Include meaningful tests, fixtures, documentation, and a README with the exact commands needed to build/test/run it. Do not make a fake no-op implementation or weaken the check; reviewer approval depends on the implementation meeting the real requirements above.",
  ].join("\n");

  const subjectiveCriteria = [
    `Review ${dir} as production work, not as a kata stub.`,
    "The implementation must match the stated product/system behavior and handle non-happy-path cases.",
    "Tests must exercise edge cases and failure modes instead of only checking that files exist.",
    "The README must be accurate and the deterministic check must pass without manual steps after declared dependencies are installed.",
    ...(spec.criteria ?? []),
  ].join("\n");

  return {
    slug: spec.slug,
    title: spec.title,
    domain: spec.domain,
    reservation: spec.reservation,
    reviewFee: spec.reviewFee ?? DEFAULT_PRETRAIN_REVIEW_FEE,
    check: spec.check,
    description,
    subjectiveCriteria,
  };
}

function roundRobin<T>(groups: T[][]): T[] {
  const out: T[] = [];
  const max = Math.max(...groups.map((g) => g.length));
  for (let i = 0; i < max; i++) {
    for (const g of groups) {
      if (i < g.length) out.push(g[i]);
    }
  }
  return out;
}

const nextjsTasks = [
  makeTask({
    domain: "nextjs",
    slug: "nextjs-incident-command-center",
    title: "Create a Next.js incident command center for an on-call team",
    reservation: 8_000_000,
    check: "cd pretrain/nextjs-incident-command-center && bun install && bun run build && bun test",
    requirements: [
      "Create a Next.js App Router TypeScript app with seeded incidents, severity filters, responder assignment, timeline notes, and postmortem draft pages.",
      "Implement local route handlers or server actions for incident CRUD with schema validation and deterministic seeded storage.",
      "Add accessible loading/empty/error states, keyboard-friendly navigation, and responsive layouts for desktop and mobile.",
      "Add tests for filtering, severity transitions, timeline rendering, and postmortem serialization.",
    ],
  }),
  makeTask({
    domain: "nextjs",
    slug: "nextjs-multi-tenant-billing-portal",
    title: "Build a multi-tenant billing/admin portal in Next.js",
    reservation: 8_500_000,
    check: "cd pretrain/nextjs-multi-tenant-billing-portal && bun install && bun run build && bun test",
    requirements: [
      "Create tenant switcher, plan comparison, usage meters, invoice list, payment failure banner, and admin audit log screens.",
      "Model tenant-scoped permissions so viewers cannot mutate billing state while owners can update plan and invoice metadata.",
      "Use deterministic local data and route handlers; no real Stripe/API calls, but keep interfaces shaped like production adapters.",
      "Test tenant isolation, permission checks, invoice totals, and plan change validation.",
    ],
  }),
  makeTask({
    domain: "nextjs",
    slug: "nextjs-feature-flag-console",
    title: "Create a feature-flag rollout console with auditability",
    reservation: 7_750_000,
    check: "cd pretrain/nextjs-feature-flag-console && bun install && bun run build && bun test",
    requirements: [
      "Implement flag list, targeting rules, percentage rollout editor, environment comparison, kill switch, and audit trail views.",
      "Add deterministic evaluation logic for users with attributes and stable percentage bucketing.",
      "Expose route handlers for create/update/archive/evaluate using validated request bodies and clear error responses.",
      "Test bucketing determinism, rule precedence, archived flags, and audit trail entries.",
    ],
  }),
  makeTask({
    domain: "nextjs",
    slug: "nextjs-log-search-observability",
    title: "Build a log-search observability UI with saved queries",
    reservation: 8_250_000,
    check: "cd pretrain/nextjs-log-search-observability && bun install && bun run build && bun test",
    requirements: [
      "Create a Next.js dashboard for log streams with query builder, time range picker, facets, trace correlation panel, and saved queries.",
      "Implement an in-memory search adapter that supports structured fields, phrase search, severity filters, and pagination over seeded logs.",
      "Provide robust empty/error/loading states and guard against malformed query syntax.",
      "Test parser behavior, pagination stability, saved-query CRUD, and trace correlation rendering.",
    ],
  }),
  makeTask({
    domain: "nextjs",
    slug: "nextjs-offline-field-service",
    title: "Create an offline-first field-service work-order app",
    reservation: 8_750_000,
    check: "cd pretrain/nextjs-offline-field-service && bun install && bun run build && bun test",
    requirements: [
      "Build work-order list/detail/checklist/photo-note mock screens with offline queue and sync status indicators.",
      "Implement deterministic local persistence abstractions for queued mutations, conflict detection, and retry/backoff state.",
      "Surface conflicts in the UI with resolution actions and clear operator messaging.",
      "Test queued mutation ordering, conflict resolution, retry state transitions, and form validation.",
    ],
  }),
  makeTask({
    domain: "nextjs",
    slug: "nextjs-ai-workbench-mock",
    title: "Build a mock AI evaluation workbench for prompt regression testing",
    reservation: 7_500_000,
    check: "cd pretrain/nextjs-ai-workbench-mock && bun install && bun run build && bun test",
    requirements: [
      "Create prompt dataset, evaluator rubric, run comparison, trace detail, and score distribution pages using deterministic mocked model outputs.",
      "Implement local APIs for datasets, runs, rubric scoring, and regression comparison with explainable deltas.",
      "Make the UI usable for large datasets via filtering, sorting, and stable pagination.",
      "Test score aggregation, regression detection thresholds, pagination, and route-handler validation.",
    ],
  }),
  makeTask({
    domain: "nextjs",
    slug: "nextjs-security-review-tracker",
    title: "Create a security review tracker for code/application risk",
    reservation: 8_000_000,
    check: "cd pretrain/nextjs-security-review-tracker && bun install && bun run build && bun test",
    requirements: [
      "Implement risk register, finding triage, SLA dashboard, owner assignment, mitigation checklist, and evidence attachment mock flows.",
      "Model severity, exploitability, affected assets, SLA deadlines, and state transitions with validation.",
      "Add audit history for every state change and searchable filters by team, severity, SLA breach, and asset.",
      "Test SLA calculations, invalid transitions, audit-log writes, and filtering behavior.",
    ],
  }),
  makeTask({
    domain: "nextjs",
    slug: "nextjs-data-room",
    title: "Build a virtual data-room portal with document permissions",
    reservation: 8_250_000,
    check: "cd pretrain/nextjs-data-room && bun install && bun run build && bun test",
    requirements: [
      "Create document tree, permission matrix, watermark preview, Q&A thread, access request, and activity timeline screens.",
      "Implement deterministic permission checks for groups/users/documents and local route handlers for grant/revoke/request flows.",
      "Add UI safeguards around confidential documents, denied previews, and stale access requests.",
      "Test permission inheritance, explicit denies, Q&A visibility, and activity timeline ordering.",
    ],
  }),
];

const rustTasks = [
  makeTask({
    domain: "rust",
    slug: "rust-lsm-kv",
    title: "Implement a Rust log-structured key-value store with recovery",
    reservation: 10_000_000,
    check: "cargo test --manifest-path pretrain/rust-lsm-kv/Cargo.toml",
    requirements: [
      "Create a Rust crate using only the standard library; implement put/get/delete, immutable SSTable files, memtable flush, and simple compaction.",
      "Persist a write-ahead log and recover after simulated crashes without losing acknowledged writes.",
      "Use deterministic binary encodings with checksums and reject corrupt segments cleanly.",
      "Add tests for tombstones, recovery, compaction ordering, corruption handling, and large key/value cases.",
    ],
  }),
  makeTask({
    domain: "rust",
    slug: "rust-wal-segment-recovery",
    title: "Build a Rust write-ahead-log segment library with crash-safe replay",
    reservation: 9_500_000,
    check: "cargo test --manifest-path pretrain/rust-wal-segment-recovery/Cargo.toml",
    requirements: [
      "Implement append-only WAL segments with length-prefixing, checksums, rotation, fsync policy knobs, and replay iterators.",
      "Detect and truncate partial tail records after simulated torn writes while preserving earlier valid records.",
      "Expose a small CLI or example for appending/replaying records in a directory.",
      "Test segment rotation, partial writes, checksum failures, replay ordering, and idempotent recovery.",
    ],
  }),
  makeTask({
    domain: "rust",
    slug: "rust-tcp-load-balancer-sim",
    title: "Create a Rust TCP load-balancer simulator with health checks",
    reservation: 9_000_000,
    check: "cargo test --manifest-path pretrain/rust-tcp-load-balancer-sim/Cargo.toml",
    requirements: [
      "Model listeners, backends, connection draining, active health checks, retries, and least-connections/round-robin policies without external crates.",
      "Provide a deterministic simulation engine driven by events rather than wall-clock sleeps.",
      "Record metrics for accepted, retried, failed, drained, and completed connections.",
      "Test backend flapping, draining semantics, retry budgets, policy choices, and metrics accounting.",
    ],
  }),
  makeTask({
    domain: "rust",
    slug: "rust-redis-resp-streaming-parser",
    title: "Implement a streaming Redis RESP parser and encoder in Rust",
    reservation: 8_500_000,
    check: "cargo test --manifest-path pretrain/rust-redis-resp-streaming-parser/Cargo.toml",
    requirements: [
      "Support RESP2 simple strings, errors, integers, bulk strings, null bulk strings, arrays, nested arrays, and incremental partial input.",
      "Return structured parse errors with byte offsets and preserve unread input for future frames.",
      "Implement an encoder that round-trips all supported value types.",
      "Test fragmented frames, nested arrays, invalid lengths, null handling, and encode/decode round trips.",
    ],
  }),
  makeTask({
    domain: "rust",
    slug: "rust-merkle-log-auditor",
    title: "Build an append-only Merkle log auditor in Rust",
    reservation: 10_500_000,
    check: "cargo test --manifest-path pretrain/rust-merkle-log-auditor/Cargo.toml",
    requirements: [
      "Implement an append-only log with deterministic domain-separated hashing, root calculation, inclusion proofs, and consistency proofs.",
      "No external crates; implement a documented non-cryptographic test hash or wrap std hashing with clear warnings for production replacement.",
      "Provide proof verification APIs that reject malformed paths, wrong leaf indexes, and inconsistent tree sizes.",
      "Test odd leaf counts, empty logs, inclusion proofs, consistency proofs, and tampered proof rejection.",
    ],
  }),
  makeTask({
    domain: "rust",
    slug: "rust-mpsc-ring-buffer",
    title: "Create a bounded MPSC ring buffer in Rust with backpressure",
    reservation: 9_750_000,
    check: "cargo test --manifest-path pretrain/rust-mpsc-ring-buffer/Cargo.toml",
    requirements: [
      "Implement a bounded multi-producer single-consumer queue using standard-library atomics/locks only, with try_send, blocking send, recv, and close semantics.",
      "Define clear behavior for full buffers, closed receivers, producer drops, and wakeups without busy-spinning.",
      "Include a small benchmark/example comparing throughput under contention.",
      "Test FIFO ordering per producer, close behavior, full-buffer backpressure, and concurrent producers.",
    ],
  }),
  makeTask({
    domain: "rust",
    slug: "rust-container-layer-diff",
    title: "Implement a Rust container layer diff/whiteout analyzer",
    reservation: 9_250_000,
    check: "cargo test --manifest-path pretrain/rust-container-layer-diff/Cargo.toml",
    requirements: [
      "Model OCI-style filesystem layers from deterministic fixture directories or manifest files and apply whiteout semantics.",
      "Compute final filesystem view, changed paths, file metadata summaries, and duplicate content reports.",
      "Reject path traversal and malformed whiteout entries safely.",
      "Test opaque directories, whiteouts, duplicate content, path normalization, and final view calculation.",
    ],
  }),
  makeTask({
    domain: "rust",
    slug: "rust-bytecode-vm",
    title: "Build a Rust bytecode VM with assembler and debugger traces",
    reservation: 11_000_000,
    check: "cargo test --manifest-path pretrain/rust-bytecode-vm/Cargo.toml",
    requirements: [
      "Implement a small stack/register VM with arithmetic, jumps, calls, memory load/store, traps, and deterministic gas metering.",
      "Write an assembler/parser for a human-readable instruction format with labels and helpful diagnostics.",
      "Expose execution traces for debugging, including pc, gas, stack/register state, and trap reasons.",
      "Test assembler errors, control flow, gas exhaustion, memory bounds, calls/returns, and trace output.",
    ],
  }),
];

const cTasks = [
  makeTask({
    domain: "c-lowlevel",
    slug: "c-arena-allocator",
    title: "Implement a hardened arena allocator and fuzz-style test harness in C",
    reservation: 9_500_000,
    check: "make -C pretrain/c-arena-allocator test",
    requirements: [
      "Write a C library for aligned arena allocation, checkpoints/rollback, reset, large allocation fallback, and optional red-zone poisoning.",
      "Detect overflow, invalid alignment, use-after-reset in debug mode, and out-of-memory without undefined behavior.",
      "Provide a Makefile, unit tests, and a randomized deterministic stress test using a fixed seed.",
      "Document API contracts and memory ownership clearly.",
    ],
  }),
  makeTask({
    domain: "c-lowlevel",
    slug: "c-epoll-chat-server",
    title: "Create a C epoll-based chat server with protocol tests",
    reservation: 10_000_000,
    check: "make -C pretrain/c-epoll-chat-server test",
    requirements: [
      "Implement a nonblocking epoll server supporting login, rooms, broadcast, direct messages, heartbeats, and graceful disconnect.",
      "Separate protocol parsing/state-machine tests from the optional live server binary so CI can run deterministically.",
      "Handle partial reads/writes, backpressure, malformed frames, and oversized messages safely.",
      "Add tests for parser fragmentation, room routing, direct messages, and disconnect cleanup.",
    ],
  }),
  makeTask({
    domain: "c-lowlevel",
    slug: "c-elf-symbol-inspector",
    title: "Build an ELF64 symbol/relocation inspector in C",
    reservation: 9_250_000,
    check: "make -C pretrain/c-elf-symbol-inspector test",
    requirements: [
      "Parse ELF64 headers, section headers, string tables, symbol tables, and a useful subset of relocations without external libraries.",
      "Reject truncated/malformed files with explicit errors instead of crashes or unchecked pointer arithmetic.",
      "Provide a CLI that prints imported/exported symbols and relocation summaries for fixture binaries.",
      "Add generated binary fixtures and tests for valid files, truncation, wrong endian/class, and missing string tables.",
    ],
  }),
  makeTask({
    domain: "c-lowlevel",
    slug: "c-png-chunk-rewriter",
    title: "Implement a safe PNG chunk parser/rewriter in C",
    reservation: 8_750_000,
    check: "make -C pretrain/c-png-chunk-rewriter test",
    requirements: [
      "Parse PNG signatures and chunks, validate CRCs, preserve unknown ancillary chunks, and rewrite text metadata deterministically.",
      "Reject malformed lengths, CRC mismatches, invalid chunk ordering, and integer overflows.",
      "Provide a CLI for listing chunks and adding/replacing tEXt metadata in fixture PNGs.",
      "Test CRC validation, chunk ordering, metadata replacement, unknown chunk preservation, and corrupt inputs.",
    ],
  }),
  makeTask({
    domain: "c-lowlevel",
    slug: "c-wal-recovery",
    title: "Create a C write-ahead-log recovery library",
    reservation: 9_000_000,
    check: "make -C pretrain/c-wal-recovery test",
    requirements: [
      "Implement binary WAL records with magic/version, length, checksum, record type, and payload.",
      "Support append, flush, replay, corruption detection, and tail truncation after simulated torn writes.",
      "Avoid undefined behavior in binary parsing; handle endian and overflow explicitly.",
      "Test partial records, checksum errors, replay ordering, segment rotation, and idempotent truncation.",
    ],
  }),
  makeTask({
    domain: "c-lowlevel",
    slug: "c-http-parser-fuzzer",
    title: "Build a C HTTP/1.1 request parser with deterministic fuzz tests",
    reservation: 8_500_000,
    check: "make -C pretrain/c-http-parser-fuzzer test",
    requirements: [
      "Implement incremental parsing for request line, headers, content length, chunked bodies, keep-alive decisions, and parse errors.",
      "Bound memory usage and reject obs-fold, header overflows, invalid chunk sizes, and request smuggling ambiguities.",
      "Add deterministic fuzz-style tests that feed fragmented/mutated requests with a fixed seed.",
      "Test partial input, malformed headers, chunked bodies, body length mismatch, and parser reset.",
    ],
  }),
  makeTask({
    domain: "c-lowlevel",
    slug: "c-threadpool-workstealing",
    title: "Implement a C work-stealing thread pool with futures",
    reservation: 10_250_000,
    check: "make -C pretrain/c-threadpool-workstealing test",
    requirements: [
      "Build a pthread-based thread pool with per-worker deques, global injection queue, futures, cancellation, and shutdown semantics.",
      "Avoid deadlocks for nested tasks and define behavior for panicking/failing task callbacks via error codes.",
      "Provide deterministic unit tests with small workloads and stress tests gated behind the Makefile test target.",
      "Test future waiting, nested tasks, cancellation, shutdown, and work distribution.",
    ],
  }),
  makeTask({
    domain: "c-lowlevel",
    slug: "c-page-table-simulator",
    title: "Create an x86-64 page table and TLB simulator in C",
    reservation: 9_750_000,
    check: "make -C pretrain/c-page-table-simulator test",
    requirements: [
      "Simulate 4-level x86-64 page tables, page flags, huge pages, copy-on-write faults, and a small set-associative TLB.",
      "Expose APIs to map/unmap/protect/translate virtual addresses and report precise fault reasons.",
      "Model TLB invalidation and permission checks deterministically.",
      "Test canonical address checks, huge pages, COW faults, permission faults, unmap behavior, and TLB invalidation.",
    ],
  }),
];

const tsTasks = [
  makeTask({
    domain: "typescript-tooling",
    slug: "ts-openapi-breaking-change-detector",
    title: "Build a TypeScript OpenAPI breaking-change detector",
    reservation: 7_500_000,
    check: "cd pretrain/ts-openapi-breaking-change-detector && bun install && bun test && bun run typecheck",
    requirements: [
      "Create a CLI/library that compares two OpenAPI JSON specs and reports breaking, risky, and non-breaking changes.",
      "Detect removed paths/methods, request/response schema narrowing, enum changes, required-field changes, auth changes, and status-code changes.",
      "Emit machine-readable JSON and human-friendly markdown reports with stable ordering.",
      "Test nested schemas, refs, enum changes, required fields, and report formatting.",
    ],
  }),
  makeTask({
    domain: "typescript-tooling",
    slug: "ts-monorepo-task-runner",
    title: "Create a deterministic monorepo task runner in TypeScript",
    reservation: 8_000_000,
    check: "cd pretrain/ts-monorepo-task-runner && bun install && bun test && bun run typecheck",
    requirements: [
      "Implement project graph discovery from package manifests, task dependency resolution, cache key computation, and topological scheduling.",
      "Support dry-run output, affected-project filtering, parallelism limits, and cycle diagnostics.",
      "Do not actually execute arbitrary shell in tests; mock executor behavior deterministically.",
      "Test graph parsing, cycle errors, cache invalidation, affected filtering, and scheduling order.",
    ],
  }),
  makeTask({
    domain: "typescript-tooling",
    slug: "ts-sql-migration-planner",
    title: "Build a TypeScript SQL migration planner and linter",
    reservation: 7_250_000,
    check: "cd pretrain/ts-sql-migration-planner && bun install && bun test && bun run typecheck",
    requirements: [
      "Parse a practical subset of SQL DDL migrations and build before/after schema models.",
      "Flag dangerous operations such as table drops, nullable-to-non-nullable changes, incompatible type changes, and missing down migrations.",
      "Produce an ordered migration plan with dependency diagnostics for foreign keys and indexes.",
      "Test parser edge cases, dangerous-change detection, dependency ordering, and diagnostic formatting.",
    ],
  }),
  makeTask({
    domain: "typescript-tooling",
    slug: "ts-event-sourced-ledger",
    title: "Create an event-sourced ledger library in TypeScript",
    reservation: 8_250_000,
    check: "cd pretrain/ts-event-sourced-ledger && bun install && bun test && bun run typecheck",
    requirements: [
      "Implement accounts, transfers, holds, releases, idempotency keys, snapshots, and replay from append-only events.",
      "Guarantee double-entry invariants and deterministic replay even with duplicate commands.",
      "Expose a small API plus CLI fixtures for replaying event logs and printing balances.",
      "Test idempotency, holds, insufficient funds, snapshots, replay determinism, and invariant violations.",
    ],
  }),
  makeTask({
    domain: "typescript-tooling",
    slug: "ts-graphql-cache-normalizer",
    title: "Implement a GraphQL response cache normalizer in TypeScript",
    reservation: 7_000_000,
    check: "cd pretrain/ts-graphql-cache-normalizer && bun install && bun test && bun run typecheck",
    requirements: [
      "Normalize nested GraphQL responses into entity records using __typename/id keys, field arguments, fragments, and lists.",
      "Support optimistic writes, invalidation, denormalization, missing field diagnostics, and stable cache serialization.",
      "Avoid requiring a full GraphQL parser; document the supported query/selection representation.",
      "Test entity identity, lists, fragments, optimistic layers, invalidation, and denormalization misses.",
    ],
  }),
  makeTask({
    domain: "typescript-tooling",
    slug: "ts-dependency-license-auditor",
    title: "Build a dependency/license auditor for package manifests",
    reservation: 6_750_000,
    check: "cd pretrain/ts-dependency-license-auditor && bun install && bun test && bun run typecheck",
    requirements: [
      "Scan package.json and lockfile-like fixtures to produce a dependency graph, license summary, policy violations, and transitive risk report.",
      "Implement policy rules for allowed/denied licenses, unknown license handling, deprecated packages, and production/dev scopes.",
      "Output stable JSON and markdown reports suitable for CI.",
      "Test graph construction, transitive violations, unknown licenses, dev/prod filtering, and report formatting.",
    ],
  }),
  makeTask({
    domain: "typescript-tooling",
    slug: "ts-cron-workflow-engine",
    title: "Create a cron workflow engine with retries and catch-up semantics",
    reservation: 8_500_000,
    check: "cd pretrain/ts-cron-workflow-engine && bun install && bun test && bun run typecheck",
    requirements: [
      "Implement cron-like schedules, workflow DAGs, retry/backoff policies, catch-up windows, idempotency keys, and run state persistence.",
      "Use a deterministic virtual clock in tests and avoid wall-clock sleeps.",
      "Expose APIs for scheduling, ticking, querying runs, cancelling workflows, and retrying failed jobs.",
      "Test schedule parsing, missed-run catch-up, DAG ordering, retry budgets, cancellation, and idempotency.",
    ],
  }),
  makeTask({
    domain: "typescript-tooling",
    slug: "ts-binary-protocol-codegen",
    title: "Build a binary protocol code generator in TypeScript",
    reservation: 8_750_000,
    check: "cd pretrain/ts-binary-protocol-codegen && bun install && bun test && bun run typecheck",
    requirements: [
      "Define a small IDL for structs, enums, varints, fixed integers, byte arrays, optional fields, and versioned schemas.",
      "Generate TypeScript encoders/decoders with bounds checks and helpful schema diagnostics.",
      "Support backward-compatible field additions and reject incompatible changes.",
      "Test IDL parsing, generated round trips, malformed buffers, versioning, and diagnostics.",
    ],
  }),
];

const pythonInfraTasks = [
  makeTask({
    domain: "python-infra",
    slug: "py-async-crawler-frontier",
    title: "Implement an async crawler frontier and robots-aware scheduler",
    reservation: 7_250_000,
    check: "python3 -m unittest discover -s pretrain/py-async-crawler-frontier/tests -v",
    requirements: [
      "Use Python stdlib asyncio to build URL canonicalization, per-host politeness queues, robots.txt rule evaluation, retry budgets, and deduplication.",
      "Use deterministic fake fetchers/clocks in tests; no real network access.",
      "Expose APIs to enqueue URLs, lease work, complete/fail fetches, and inspect frontier metrics.",
      "Test canonicalization, robots allow/deny precedence, host politeness, retries, dedupe, and metrics.",
    ],
  }),
  makeTask({
    domain: "python-infra",
    slug: "py-mini-sql-query-planner",
    title: "Create a Python mini SQL query planner and executor",
    reservation: 7_500_000,
    check: "python3 -m unittest discover -s pretrain/py-mini-sql-query-planner/tests -v",
    requirements: [
      "Implement parsing/execution for SELECT projections, WHERE filters, joins, grouping, ordering, and limits over in-memory tables.",
      "Build a simple cost planner that chooses between nested-loop joins and indexed lookups where indexes are declared.",
      "Return explain plans with estimated rows and chosen operators.",
      "Test parser errors, joins, grouping, ordering, indexes, explain output, and edge cases around NULL-like values.",
    ],
  }),
  makeTask({
    domain: "python-infra",
    slug: "py-timeseries-rollup-engine",
    title: "Build a Python time-series rollup and retention engine",
    reservation: 7_000_000,
    check: "python3 -m unittest discover -s pretrain/py-timeseries-rollup-engine/tests -v",
    requirements: [
      "Implement ingestion of tagged metrics, fixed-window rollups, retention tiers, late data handling, and query interpolation using only stdlib.",
      "Persist deterministic fixture data to local files and recover indexes on startup.",
      "Expose APIs for ingest, compact, query, and inspect storage stats.",
      "Test window boundaries, late arrivals, retention deletion, query aggregation, and recovery.",
    ],
  }),
  makeTask({
    domain: "python-infra",
    slug: "py-crdt-document-store",
    title: "Create a Python CRDT-backed collaborative document store",
    reservation: 8_000_000,
    check: "python3 -m unittest discover -s pretrain/py-crdt-document-store/tests -v",
    requirements: [
      "Implement a sequence/document CRDT with actor IDs, operation IDs, inserts, deletes, merging, causal metadata, and compaction.",
      "Provide deterministic serialization and replay of operation logs.",
      "Handle concurrent inserts/deletes predictably and document tie-breaking rules.",
      "Test convergence, idempotent merge, concurrent edits, delete/insert races, serialization, and compaction.",
    ],
  }),
  makeTask({
    domain: "python-infra",
    slug: "py-sat-scheduler",
    title: "Build a Python SAT-style scheduler for constrained jobs",
    reservation: 7_750_000,
    check: "python3 -m unittest discover -s pretrain/py-sat-scheduler/tests -v",
    requirements: [
      "Model jobs, resources, time windows, mutual exclusions, precedence constraints, and soft preferences.",
      "Implement a backtracking/constraint-propagation solver with deterministic tie-breaking and useful unsat explanations.",
      "Expose a CLI or module API that reads JSON fixtures and prints schedules/explanations.",
      "Test satisfiable schedules, unsat cores, precedence, resource capacities, soft preference scoring, and deterministic output.",
    ],
  }),
  makeTask({
    domain: "python-infra",
    slug: "py-lsm-compaction-simulator",
    title: "Implement an LSM compaction simulator in Python",
    reservation: 7_250_000,
    check: "python3 -m unittest discover -s pretrain/py-lsm-compaction-simulator/tests -v",
    requirements: [
      "Simulate writes, memtable flushes, leveled compaction, size-tiered compaction, tombstones, snapshots, and read amplification metrics.",
      "Make compaction decisions deterministic and configurable through JSON fixtures.",
      "Emit metrics and explain why compactions were scheduled.",
      "Test tombstone retention, snapshots, leveled vs size-tiered behavior, read amplification, and deterministic compaction order.",
    ],
  }),
  makeTask({
    domain: "python-infra",
    slug: "py-consensus-raft-simulator",
    title: "Create a Python Raft consensus simulator",
    reservation: 9_000_000,
    check: "python3 -m unittest discover -s pretrain/py-consensus-raft-simulator/tests -v",
    requirements: [
      "Implement deterministic Raft leader election, log replication, terms, commit indexes, partitions, crashes, restarts, and snapshots in a simulated cluster.",
      "Use a virtual clock and scripted network partitions; no threads or real sleeps required.",
      "Expose scenario fixtures and trace output for debugging consensus behavior.",
      "Test elections, split votes, log conflict resolution, partition healing, crash recovery, and safety invariants.",
    ],
  }),
  makeTask({
    domain: "python-infra",
    slug: "py-log-anomaly-detector",
    title: "Build a Python streaming log anomaly detector",
    reservation: 6_500_000,
    check: "python3 -m unittest discover -s pretrain/py-log-anomaly-detector/tests -v",
    requirements: [
      "Parse structured/unstructured logs into templates, maintain streaming frequency baselines, detect spikes/novel templates, and explain alerts.",
      "Use deterministic fixture streams and configurable thresholds; no ML dependencies.",
      "Persist baseline snapshots and reload them for continued detection.",
      "Test template extraction, baseline updates, spike detection, novel events, snapshot recovery, and false-positive controls.",
    ],
  }),
];

const dataBackendTasks = [
  makeTask({
    domain: "data-backend",
    slug: "py-sqlite-job-queue",
    title: "Implement a SQLite-backed durable job queue in Python",
    reservation: 7_750_000,
    check: "python3 -m unittest discover -s pretrain/py-sqlite-job-queue/tests -v",
    requirements: [
      "Use Python stdlib sqlite3 to implement enqueue, lease, heartbeat, retry, dead-letter, priority, delayed jobs, and idempotency keys.",
      "Handle worker crashes by expiring leases and making jobs visible again deterministically.",
      "Expose a module API plus a small CLI for queue inspection and repair.",
      "Test concurrency-ish leasing with multiple connections, retries, delayed jobs, dead letters, idempotency, and crash recovery.",
    ],
  }),
  makeTask({
    domain: "data-backend",
    slug: "ts-webhook-delivery-service",
    title: "Create a TypeScript webhook delivery service core",
    reservation: 7_500_000,
    check: "cd pretrain/ts-webhook-delivery-service && bun install && bun test && bun run typecheck",
    requirements: [
      "Implement subscriptions, event fanout, signing, retry/backoff, idempotency, delivery logs, and dead-letter handling.",
      "Use deterministic in-memory adapters for persistence/HTTP and a virtual clock in tests.",
      "Support per-endpoint rate limits, disabled endpoints, and secret rotation.",
      "Test signature generation, retries, backoff, rate limits, idempotency, dead letters, and secret rotation.",
    ],
  }),
  makeTask({
    domain: "data-backend",
    slug: "py-parquetish-column-store",
    title: "Build a small columnar storage format and query reader in Python",
    reservation: 8_000_000,
    check: "python3 -m unittest discover -s pretrain/py-parquetish-column-store/tests -v",
    requirements: [
      "Design a deterministic columnar file format with row groups, column chunks, dictionary/RLE encoding, min/max statistics, and checksums.",
      "Implement writer, reader, predicate pushdown, projection, and corruption errors using only stdlib.",
      "Provide fixture generation and a CLI to inspect file metadata.",
      "Test encoding round trips, predicate pushdown, projection, checksums, corrupt files, and metadata inspection.",
    ],
  }),
  makeTask({
    domain: "data-backend",
    slug: "ts-metrics-alert-router",
    title: "Implement a TypeScript metrics alert routing engine",
    reservation: 7_250_000,
    check: "cd pretrain/ts-metrics-alert-router && bun install && bun test && bun run typecheck",
    requirements: [
      "Model alert rules, threshold windows, deduplication, grouping, inhibition, escalation policies, silences, and notification routes.",
      "Use deterministic virtual time and in-memory metric streams.",
      "Output explainable decisions for why alerts fired, were silenced, or were routed to a receiver.",
      "Test threshold windows, grouping, silences, inhibition, escalations, and explain output.",
    ],
  }),
  makeTask({
    domain: "data-backend",
    slug: "py-incremental-backup-deduper",
    title: "Create an incremental backup deduplication engine in Python",
    reservation: 8_250_000,
    check: "python3 -m unittest discover -s pretrain/py-incremental-backup-deduper/tests -v",
    requirements: [
      "Implement content-defined chunking or fixed chunking with manifests, deduplication indexes, snapshots, restore, pruning, and integrity verification.",
      "Use local fixture directories only and deterministic hashes from hashlib.",
      "Detect missing/corrupt chunks and provide repair diagnostics.",
      "Test dedupe across snapshots, restore correctness, pruning safety, corrupt chunk detection, and manifest versioning.",
    ],
  }),
  makeTask({
    domain: "data-backend",
    slug: "ts-local-first-sync-engine",
    title: "Build a local-first sync engine in TypeScript",
    reservation: 8_750_000,
    check: "cd pretrain/ts-local-first-sync-engine && bun install && bun test && bun run typecheck",
    requirements: [
      "Implement client/server change logs, vector clocks, optimistic local writes, conflict detection/resolution hooks, tombstones, and checkpoint sync.",
      "Use deterministic in-memory transports that can drop/reorder/duplicate messages in tests.",
      "Expose APIs for local mutations, sync, conflict inspection, and compaction.",
      "Test convergence, duplicates, reordering, tombstones, checkpoint resume, and conflict hooks.",
    ],
  }),
  makeTask({
    domain: "data-backend",
    slug: "py-email-ingestion-pipeline",
    title: "Implement an email ingestion/classification pipeline in Python",
    reservation: 6_750_000,
    check: "python3 -m unittest discover -s pretrain/py-email-ingestion-pipeline/tests -v",
    requirements: [
      "Parse MIME emails, extract plain/html bodies, attachments metadata, threading headers, sender domains, and deterministic classification labels.",
      "Handle malformed MIME, huge attachments by metadata only, duplicate message IDs, and quarantine rules.",
      "Produce normalized JSON records and pipeline metrics.",
      "Test MIME variants, malformed messages, duplicate detection, quarantine, classification, and JSON output stability.",
    ],
  }),
  makeTask({
    domain: "data-backend",
    slug: "ts-permission-policy-engine",
    title: "Create a policy/permission evaluation engine in TypeScript",
    reservation: 7_750_000,
    check: "cd pretrain/ts-permission-policy-engine && bun install && bun test && bun run typecheck",
    requirements: [
      "Implement a small policy language for subjects, resources, actions, conditions, role inheritance, explicit deny, and audit explanations.",
      "Add parser/validator, evaluator, conflict diagnostics, and stable serialization.",
      "Support batched authorization checks with shared context and short-circuiting rules.",
      "Test parser errors, role inheritance, explicit deny precedence, conditions, batched checks, and explanation output.",
    ],
  }),
];

const securityTasks = [
  makeTask({
    domain: "security-crypto",
    slug: "rust-constant-time-token-vault",
    title: "Build a Rust token vault with constant-time verification semantics",
    reservation: 9_000_000,
    check: "cargo test --manifest-path pretrain/rust-constant-time-token-vault/Cargo.toml",
    requirements: [
      "Implement token issuance, hashing with a documented deterministic test hash, expiry, rotation, revocation, and audit events using only stdlib.",
      "Provide constant-time byte comparison and structure APIs so verification does not leak early mismatch positions.",
      "Separate test hash interfaces from production placeholders and document replacement points for real crypto.",
      "Test expiry, revocation, rotation, audit logs, malformed tokens, and constant-time comparison behavior.",
    ],
  }),
  makeTask({
    domain: "security-crypto",
    slug: "py-jwt-verifier-hs256",
    title: "Implement a strict HS256 JWT verifier in Python",
    reservation: 8_000_000,
    check: "python3 -m unittest discover -s pretrain/py-jwt-verifier-hs256/tests -v",
    requirements: [
      "Use only stdlib base64/json/hmac/hashlib to verify HS256 JWTs with strict alg, typ, exp, nbf, iat, aud, iss, and kid handling.",
      "Reject alg none, duplicated/unknown critical headers, invalid base64url, non-canonical JSON where feasible, and clock-skew violations.",
      "Expose helpful verification errors without leaking secrets.",
      "Test valid tokens, alg confusion, expiry/skew, audience/issuer, key selection, malformed segments, and signature failures.",
    ],
  }),
  makeTask({
    domain: "security-crypto",
    slug: "c-side-channel-safe-memcmp",
    title: "Create a C side-channel-safe comparison and benchmark harness",
    reservation: 8_500_000,
    check: "make -C pretrain/c-side-channel-safe-memcmp test",
    requirements: [
      "Implement constant-time equality for byte slices, masked selection helpers, and defensive APIs that avoid undefined behavior on null/zero length.",
      "Add tests that compare behavior against memcmp and inspect that comparison work does not short-circuit by position.",
      "Provide a simple benchmark/demo with clear caveats about measuring side channels.",
      "Test equal/unequal buffers, different lengths, zero-length, null handling according to API contract, and no early-exit instrumentation.",
    ],
  }),
  makeTask({
    domain: "security-crypto",
    slug: "ts-signed-webhook-verifier",
    title: "Build a robust signed webhook verifier in TypeScript",
    reservation: 7_500_000,
    check: "cd pretrain/ts-signed-webhook-verifier && bun install && bun test && bun run typecheck",
    requirements: [
      "Use Node/Bun crypto APIs to verify timestamped HMAC signatures over raw request bodies with secret rotation and replay protection.",
      "Support multiple signature versions, canonical header parsing, clock skew, tolerance windows, and structured error reporting.",
      "Do not parse JSON before signature verification; preserve raw bytes in tests.",
      "Test valid signatures, replay, old timestamps, secret rotation, malformed headers, raw body differences, and timing-safe comparisons.",
    ],
  }),
  makeTask({
    domain: "security-crypto",
    slug: "rust-sparse-nullifier-set",
    title: "Implement a Rust sparse Merkle nullifier-set simulator",
    reservation: 11_500_000,
    check: "cargo test --manifest-path pretrain/rust-sparse-nullifier-set/Cargo.toml",
    requirements: [
      "Implement sparse tree insert, membership proof, non-membership proof, root updates, and duplicate-nullifier rejection using a documented deterministic test hash.",
      "Use fixed-depth keys, domain-separated node/leaf hashing, and explicit proof verification APIs.",
      "Optimize storage by keeping only populated branches and cached empty subtree roots.",
      "Test empty tree proofs, insert/update roots, duplicate rejection, proof verification, tampered proofs, and path divergence cases.",
    ],
  }),
  makeTask({
    domain: "security-crypto",
    slug: "py-supply-chain-manifest-verifier",
    title: "Build a supply-chain artifact manifest verifier in Python",
    reservation: 8_250_000,
    check: "python3 -m unittest discover -s pretrain/py-supply-chain-manifest-verifier/tests -v",
    requirements: [
      "Verify JSON manifests that bind artifact paths to sizes, SHA-256 digests, build metadata, and trusted signer IDs using deterministic fixture signatures.",
      "Protect against path traversal, duplicate paths, manifest rollback by version, missing artifacts, and digest mismatches.",
      "Emit machine-readable verification reports and human-friendly summaries.",
      "Test valid manifests, path traversal, duplicate entries, rollback, missing files, digest mismatch, and report formatting.",
    ],
  }),
  makeTask({
    domain: "security-crypto",
    slug: "c-secure-tar-extractor",
    title: "Create a safe tar extractor core in C",
    reservation: 9_250_000,
    check: "make -C pretrain/c-secure-tar-extractor test",
    requirements: [
      "Parse ustar headers, regular files, directories, symlinks metadata, checksums, and padding without external libraries.",
      "Prevent path traversal, absolute paths, unsafe symlinks, duplicate overwrite surprises, and integer overflow before extraction.",
      "Implement tests against in-memory tar fixtures; actual extraction can target a temporary directory under the test tree.",
      "Test valid archives, traversal attempts, absolute paths, symlink policy, checksum failures, long names, and malformed sizes.",
    ],
  }),
  makeTask({
    domain: "security-crypto",
    slug: "ts-oauth-device-flow-simulator",
    title: "Implement an OAuth device-flow simulator and verifier in TypeScript",
    reservation: 7_750_000,
    check: "cd pretrain/ts-oauth-device-flow-simulator && bun install && bun test && bun run typecheck",
    requirements: [
      "Model device code issuance, user code verification, polling interval enforcement, pending/slow_down/expired states, token issuance, and revocation.",
      "Use deterministic virtual time and in-memory stores; no real HTTP server required unless wrapped by tests.",
      "Validate clients, scopes, rate limits, and replay behavior with structured errors.",
      "Test polling rules, expiry, approval/denial, rate limits, token issuance, revocation, and replay attempts.",
    ],
  }),
];

const distributedTasks = [
  makeTask({
    domain: "distributed-devops",
    slug: "py-k8s-controller-simulator",
    title: "Create a Kubernetes controller reconciliation simulator in Python",
    reservation: 8_000_000,
    check: "python3 -m unittest discover -s pretrain/py-k8s-controller-simulator/tests -v",
    requirements: [
      "Model desired/observed resources, finalizers, owner references, status conditions, rate-limited work queues, and idempotent reconcile loops.",
      "Use deterministic fake API server state and virtual time; no real cluster.",
      "Expose scenario fixtures that show create/update/delete/error/retry flows.",
      "Test idempotency, finalizers, conflict retries, owner cleanup, status updates, and rate limiting.",
    ],
  }),
  makeTask({
    domain: "distributed-devops",
    slug: "ts-docker-compose-dev-env-validator",
    title: "Build a Docker Compose dev-environment validator in TypeScript",
    reservation: 6_750_000,
    check: "cd pretrain/ts-docker-compose-dev-env-validator && bun install && bun test && bun run typecheck",
    requirements: [
      "Parse compose-like YAML/JSON fixtures into services, networks, volumes, ports, healthchecks, dependencies, and environment variables.",
      "Detect port conflicts, missing healthchecks, insecure env secrets, dependency cycles, invalid bind mounts, and unpinned images.",
      "Output stable CI diagnostics with severity, path, and remediation text.",
      "Test parser behavior, each diagnostic class, cycle detection, and stable output formatting.",
    ],
  }),
  makeTask({
    domain: "distributed-devops",
    slug: "rust-service-discovery-gossip-sim",
    title: "Implement a Rust service-discovery gossip simulator",
    reservation: 9_750_000,
    check: "cargo test --manifest-path pretrain/rust-service-discovery-gossip-sim/Cargo.toml",
    requirements: [
      "Model nodes, membership states, gossip rounds, failure detectors, anti-entropy, tombstones, and partitions using deterministic simulation.",
      "Expose APIs to script joins/leaves/failures/partitions and collect convergence metrics.",
      "Keep implementation std-only and avoid wall-clock sleeps in tests.",
      "Test convergence, partitions/healing, tombstone expiry, failure detector suspicion, and deterministic metrics.",
    ],
  }),
  makeTask({
    domain: "distributed-devops",
    slug: "c-log-structured-filesystem-sim",
    title: "Create a C log-structured filesystem simulator",
    reservation: 10_500_000,
    check: "make -C pretrain/c-log-structured-filesystem-sim test",
    requirements: [
      "Simulate blocks, segments, inodes, directories, writes, deletes, checkpoints, crash recovery, and segment cleaning.",
      "Use a deterministic in-memory block device plus optional fixture files for persistence tests.",
      "Detect corruption and recover to the latest valid checkpoint without unsafe parsing.",
      "Test writes, deletes, directory lookup, cleaning, crash recovery, checkpoint rollback, and corruption handling.",
    ],
  }),
  makeTask({
    domain: "distributed-devops",
    slug: "py-rate-limited-task-runner",
    title: "Build a rate-limited distributed task-runner simulator in Python",
    reservation: 7_250_000,
    check: "python3 -m unittest discover -s pretrain/py-rate-limited-task-runner/tests -v",
    requirements: [
      "Model tenants, tasks, priorities, token-bucket rate limits, worker pools, retries, deadlines, and fairness scheduling.",
      "Use virtual time and deterministic workers; no real sleeps or subprocess execution in tests.",
      "Expose metrics and traces for why tasks were delayed, retried, dropped, or completed.",
      "Test fairness, rate limits, priority inversion avoidance, retries, deadlines, and trace output.",
    ],
  }),
  makeTask({
    domain: "distributed-devops",
    slug: "ts-release-train-orchestrator",
    title: "Create a release-train orchestration engine in TypeScript",
    reservation: 7_750_000,
    check: "cd pretrain/ts-release-train-orchestrator && bun install && bun test && bun run typecheck",
    requirements: [
      "Model services, versions, environments, approvals, canaries, rollback plans, dependency gates, and freeze windows.",
      "Implement deterministic state transitions and explain blocked releases with actionable diagnostics.",
      "Support dry-run plans and event-sourced audit logs.",
      "Test dependency gates, approvals, canary failure, rollback, freeze windows, dry-run plans, and audit logs.",
    ],
  }),
  makeTask({
    domain: "distributed-devops",
    slug: "rust-priority-retry-queue",
    title: "Build a Rust durable priority retry queue",
    reservation: 9_250_000,
    check: "cargo test --manifest-path pretrain/rust-priority-retry-queue/Cargo.toml",
    requirements: [
      "Implement priority queues with delayed visibility, retry/backoff, leasing, acknowledgement, dead letters, and file-backed persistence using std only.",
      "Recover from partial writes and preserve at-least-once semantics after restart.",
      "Expose queue metrics and a simple example binary for enqueue/lease/ack/retry.",
      "Test priority ordering, delayed jobs, lease expiry, retries, dead letters, persistence recovery, and partial-write handling.",
    ],
  }),
  makeTask({
    domain: "distributed-devops",
    slug: "py-chaos-proxy-simulator",
    title: "Implement a deterministic chaos proxy/network simulator in Python",
    reservation: 7_500_000,
    check: "python3 -m unittest discover -s pretrain/py-chaos-proxy-simulator/tests -v",
    requirements: [
      "Model streams through a proxy with latency, jitter, packet loss, duplication, reordering, bandwidth limits, and scripted partitions.",
      "Use deterministic RNG seeds and virtual time; no real sockets required for tests.",
      "Expose APIs for injecting faults, advancing time, and collecting per-flow metrics.",
      "Test latency distributions, drops, reordering, duplication, bandwidth shaping, partitions, and metrics accounting.",
    ],
  }),
];

export const PRETRAIN_TASKS: PretrainTaskTemplate[] = roundRobin([
  nextjsTasks,
  rustTasks,
  cTasks,
  tsTasks,
  pythonInfraTasks,
  dataBackendTasks,
  securityTasks,
  distributedTasks,
]);
