# forge-crypto

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ramdanceo22/forge-crypto/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ramdanceo22/forge-crypto/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

ForgeCrypto — a standalone GitHub-compatible git forge in one Node process. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
npm start
```

The forge binds an ephemeral port, registers it with the make.fun env
(`MAKEFUN_ENV_URL`), and serves until the env says the trial is done. With no
env set it exits at once — for local development, set `MAKEFUN_ENV_URL` to a
local env server, or drive the app directly through `startServer` in `app.ts`.

## What it does

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack protocol v2
  (ls-refs, fetch, shallow) and v0, receive-pack v0 with report-status,
  side-band-64k, delete-refs, fast-forward only. Real `git clone`, `fetch`
  and `push` work against it.
- **REST v3** (`/api/v3`): repositories, branches, commits, contents, labels,
  issues, comments and pull requests, with pagination, Link headers and the
  `X-GitHub-Request-Id` header on every reply.
- **GraphQL v4** (`/api/graphql`): the documents `gh` and
  `github-mcp-server` send — viewer, repository, issues, pull requests,
  mutations, node lookup and introspection — plus batched operations.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP, `server/discover`
  (2026-07-28) and the legacy `initialize` handshake, with tools to create
  repositories, issues and pull requests and to merge them.

## Layout

- `main.ts` — the entry <-> env lifecycle (register, poll `/done`, exit 0).
- `app.ts` — the HTTP server: routing, Bearer auth, git smart-HTTP routes.
- `store.ts` — the in-memory store: repos, branches, objects, issues, pulls.
- `git.ts` — packfiles, deltas, v0/v2 upload-pack, receive-pack.
- `rest.ts` — the REST v3 dispatcher.
- `graphql.ts` — the GraphQL parser and resolvers.
- `mcp.ts` — the MCP endpoint and tools.
- `util.ts` — deterministic time, ids, pkt-lines, JSON helpers.

## Local verification

Before submission the forge was driven locally with the real `git` CLI and
plain HTTP clients (no Docker on this machine): 20/20 smoke checks pass —
REST create/read/contents/issues/labels, GraphQL viewer/introspection/query/
invalid-field/unknown-repo, MCP discover/tools-list/tools-call/unknown-tool/
parse-error, and a `git clone` + `push` + `clone` round-trip over protocol v2.
Protocol v0 clone, push, non-fast-forward refusal and fetch-back pass too.

## Notes

- Node 22 standard library only; no dependencies, no git binary, no network
  calls from the forge itself.
- Fully deterministic: timestamps come from `MAKEFUN_TRIAL_NOW` (else a fixed
  constant), ids from sequential counters, so a replay produces a
  byte-identical state export. No `Date.now()`, `new Date()` or `Math.random()`
  anywhere in the forge.
- Auth is an exact Bearer match against `MAKEFUN_SHOP_TOKEN` when it is set;
  with no token configured, any non-empty Bearer token is accepted (local dev).

---

<sub>Entered on [make.fun](https://make.fun/?ref=z2jp1edg&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
