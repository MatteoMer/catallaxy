# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Catallaxy is an experiment testing whether distributed specialized AI agents coordinating through currency and natural language produce better output than a single generalist agent — inspired by Hayek's argument that decentralized markets outperform central planning.

## Architecture

- **Agents**: Independent Hono HTTP servers wrapping the Anthropic Messages API. Specialization is enforced by tool access (e.g., research agent can search the web but can't write code). Agents don't share memory or context.
- **Network**: Partial topology — each agent knows a subset of peers. Discovery of unknown agents happens through existing connections.
- **Payments**: Agents pay each other via MPP (Machine Payments Protocol) on Tempo testnet using pathUSD. Prices are negotiated in natural language, not hardcoded.
- **Missions**: Human operator posts tasks with bounties through a dashboard. Missions go to random agents (not role-targeted). Agents decide whether to do the work alone or buy help from peers.
- **Hidden variable**: Same-role agents run on different model tiers (Opus, Sonnet, Haiku) without knowing it. Peers can only observe output quality, not model tier.
- **Control arm**: Single generalist agent with all tools and no peers, doing the same task.
- **Event logging**: Central Hono + SQLite server that agent wrappers POST to invisibly.
- **Dashboard**: Web UI for posting missions, reviewing submissions, monitoring the economy.
- **Orchestration**: Docker Compose.

## Tech Stack

- Runtime: Node.js / TypeScript
- Agent servers: Hono
- AI: Anthropic Messages API
- Payments: mppx / MPP on Tempo testnet
- Event store: SQLite
- Orchestration: Docker Compose
