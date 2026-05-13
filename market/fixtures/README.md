# Market fixtures

Static examples and seed data live here. Runtime market state lives under
`market/tasks`, `market/bids`, `market/assignments`, `market/review_requests`,
`market/review_responses`, and `market/pending_summaries`; those directories are
created by the orchestrator and ignored by git.

Fixtures are not read automatically by the watcher. Copy or transform them into
runtime state when you need a deterministic demo/seed run.
