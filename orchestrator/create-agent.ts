/**
 * Create a new agent from the template.
 *
 * Usage:
 *   bun orchestrator/create-agent.ts <name>
 */

import { cp } from "node:fs/promises";

const AGENTS_DIR = process.env.AGENTS_DIR ?? "./agents";
const TEMPLATE_DIR = `${AGENTS_DIR}/_template`;

const name = process.argv[2];
if (!name) {
  console.error("Usage: bun orchestrator/create-agent.ts <name>");
  process.exit(1);
}

const dest = `${AGENTS_DIR}/${name}`;

// Copy template
await cp(TEMPLATE_DIR, dest, { recursive: true });

// Write identity
await Bun.write(`${dest}/identity.json`, JSON.stringify({ name }, null, 2));

console.log(`Created agent "${name}" at ${dest}`);
