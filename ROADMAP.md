# mm-slack-cb-pr-status

A Slack bot that watches a review channel for GitHub PR links and keeps an emoji on each message reflecting the PR's current review state — so the team can see at a glance what still needs eyes, without anyone manually managing reactions.

## Behavior

When a message containing a GitHub PR link is posted in a watched channel, the bot tracks that PR and maintains exactly one "status" reaction on the message:

| PR state              | Condition                                  | Reaction        |
| --------------------- | ------------------------------------------ | --------------- |
| No reviews            | 0 approvals                                | *(none)*        |
| Partially reviewed    | 1 approval (of 2 required)                 | `:1of2:` |
| Fully approved        | approvals ≥ required                       | `:white_check_mark:` |
| Merged                | PR merged                                  | `:merged:` |
| Closed without merge  | PR closed, not merged                      | `:x:` |

Rules:

- The bot only ever adds/removes emojis from its **managed emoji set** (the table above). Human-added reactions are never touched. (The Slack API enforces half of this for us: `reactions.remove` can only remove reactions the bot itself added.)
- At most one managed reaction per message at a time. State transitions = remove old, add new.
- If the same PR is linked in multiple messages, all of them get updated.
- Tracking stops (and the row is eventually cleaned up) once a PR is merged or closed.

## Architecture

One long-running Node/TypeScript process. No inbound HTTP at all:

```
┌─────────────────────────────────────────────┐
│                Railway service               │
│                                              │
│  Bolt (Socket Mode) ──▶ link detection       │
│         │                    │               │
│         │                    ▼               │
│  reaction reconciler ◀── SQLite (tracked PRs)│
│         │                    ▲               │
│         ▼                    │               │
│  Slack Web API        GitHub REST poller     │
│  (reactions.*)        (every 60–120s)        │
└─────────────────────────────────────────────┘
```

- **Slack, inbound:** Socket Mode WebSocket. Slack pushes `link_shared` events down the socket — no public URL, no request signing.
- **GitHub, inbound:** none. We **poll** the GitHub REST API for the PRs we're tracking instead of receiving webhooks. v1 decision — see "Future" for the webhook upgrade path.
- **State:** SQLite (Drizzle ORM), stored on a Railway volume.

### Why polling instead of GitHub webhooks (v1)

- No public endpoint → no webhook signature verification, no ingress config, nothing to secure.
- No org-level GitHub webhook approval process to go through.
- We only poll PRs we're actively tracking (open PRs linked in the channel), so API usage is tiny: ~N requests per poll cycle for N open tracked PRs. A team channel realistically has < 20 open at once → well under rate limits (5,000/hr authenticated).
- Cost: status updates lag by up to one poll interval (60–120s). Acceptable for this use case.

## Tech stack

| Concern          | Choice                                    |
| ---------------- | ----------------------------------------- |
| Runtime          | Node 22 + TypeScript                      |
| Slack SDK        | `@slack/bolt` (Socket Mode)               |
| GitHub client    | `octokit`                                 |
| DB               | SQLite via `better-sqlite3` + Drizzle ORM |
| Scheduler        | in-process `setInterval` (no cron infra)  |
| Deploy           | Railway (Dockerfile or Nixpacks)          |

## Data model

```ts
// tracked_prs
{
  id: integer (pk),
  owner: text,            // e.g. "acme"
  repo: text,             // e.g. "monolith"
  number: integer,        // PR number
  state: text,            // 'no_reviews' | 'partial' | 'approved' | 'merged' | 'closed'
  approvals: integer,
  requiredApprovals: integer,   // default 2, see "Required approvals" below
  lastPolledAt: integer,
  createdAt: integer,
  closedAt: integer | null,     // set when merged/closed; used for cleanup TTL
}
// unique index on (owner, repo, number)

// pr_messages  (one PR → many Slack messages)
{
  id: integer (pk),
  prId: integer (fk → tracked_prs),
  channelId: text,
  messageTs: text,        // Slack message timestamp = message identity
  currentReaction: text | null,  // which managed emoji we last applied
}
// unique index on (prId, channelId, messageTs)
```

## Core logic

### 1. Link detection (Slack → DB)

- Subscribe to the `link_shared` event with `github.com` registered as an unfurl domain. Slack fires this only when a GitHub link is posted in a channel the bot is in — cheaper and cleaner than parsing every message.
- Parse links matching `github.com/{owner}/{repo}/pull/{number}` (tolerate trailing paths like `/files`, query params, angle brackets from Slack formatting).
- Upsert `tracked_prs`, insert `pr_messages`, then immediately poll that one PR once so the emoji appears within seconds of posting rather than waiting for the next cycle.
- Restrict to an allowlist of channel IDs (`WATCHED_CHANNELS` env var) so a PR link in #random doesn't get tracked.

### 2. State computation

Approval counting has one important subtlety: **only each reviewer's latest review counts.** Someone can approve, then request changes later. So:

```
GET /repos/{owner}/{repo}/pulls/{number}/reviews
→ group by user, keep latest by submitted_at
→ approvals = count(latest review state == APPROVED)
```

```ts
function computeState(pr): PrState {
  if (pr.merged) return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (approvals >= required) return 'approved';
  if (approvals > 0) return 'partial';
  return 'no_reviews';
}
```

**Required approvals:** v1 uses a static `REQUIRED_APPROVALS` env var (default 2). Reading branch protection rules per-repo is possible (`GET /repos/{o}/{r}/branches/{branch}/protection`) but needs elevated permissions — punt to Future.

### 3. Poll loop

Every `POLL_INTERVAL_SECONDS` (default 90):

1. Select all `tracked_prs` where `state NOT IN ('merged', 'closed')`.
2. For each: fetch PR (`GET /pulls/{n}`) + reviews, compute new state.
3. If state changed → update row → reconcile reactions on every linked message.
4. Cleanup pass: delete PRs (and their messages) where `closedAt` is older than 7 days.

Failure handling: wrap each PR's poll in try/catch so one 404 (deleted repo/PR) doesn't kill the cycle; a 404 marks the PR `closed`.

### 4. Reaction reconciliation

For each `pr_messages` row of a PR whose state changed:

1. Determine target emoji from the new state (may be none).
2. If `currentReaction` is set and differs → `reactions.remove(currentReaction)`.
3. If target exists and differs → `reactions.add(target)`.
4. Update `currentReaction`.

Handle the two benign Slack errors explicitly: `already_reacted` (treat as success) and `no_reaction` (treat remove as success). Handle `message_not_found` (message deleted) by deleting the `pr_messages` row.

## Slack app setup (one-time)

1. Create the app at api.slack.com/apps **from a manifest** (keep `slack-manifest.yml` in the repo):
   - Bot scopes: `reactions:read`, `reactions:write`, `links:read`, `channels:history`
   - Event subscription: `link_shared`
   - Unfurl domain: `github.com`
   - Socket Mode: enabled
2. Generate an **app-level token** (`xapp-…`) with `connections:write` (this is what Socket Mode connects with).
3. Install to workspace → get the **bot token** (`xoxb-…`). May require workspace admin approval.
4. `/invite @mm-slack-cb-pr-status` into the review channel(s).
5. Create/choose the custom emoji for "merged" if the workspace doesn't have one.

## GitHub setup (one-time)

- Fine-grained PAT (or GitHub App installation token if org policy prefers) with **read-only Pull Requests** permission on the relevant repo(s).
- If the org uses SAML SSO, remember to authorize the token for the org.

## Configuration

| Env var                  | Example                  | Notes                              |
| ------------------------ | ------------------------ | ---------------------------------- |
| `SLACK_BOT_TOKEN`        | `xoxb-…`                 | Web API calls                      |
| `SLACK_APP_TOKEN`        | `xapp-…`                 | Socket Mode connection             |
| `GITHUB_TOKEN`           | `github_pat_…`           | Read-only PR access                |
| `WATCHED_CHANNELS`       | `C0123ABC,C0456DEF`      | Channel ID allowlist               |
| `REQUIRED_APPROVALS`     | `2`                      | Static for v1                      |
| `POLL_INTERVAL_SECONDS`  | `90`                     |                                    |
| `EMOJI_PARTIAL`          | `1of2`                   | Emoji names, no colons             |
| `EMOJI_APPROVED`         | `white_check_mark`       |                                    |
| `EMOJI_MERGED`           | `merged`                 |                                    |
| `DATABASE_PATH`          | `/data/bot.sqlite`       | Points at the Railway volume       |

## Portability requirements

Railway is the initial host, not an architectural dependency. The bot must be trivially movable to EC2, a VPS, on-prem, or any container platform. Concretely:

- **The Dockerfile is the canonical deployment artifact.** Write a real multi-stage Dockerfile from day one and have Railway build from it (don't rely on Nixpacks auto-detection). Anything that runs `docker run` with the right env vars can host this — ECS, a plain EC2 instance, Fly, a homelab box.
- **Strict 12-factor config.** All configuration through env vars, zero Railway SDK/API usage, no reading Railway-injected metadata, no reliance on Railway-specific env var names. A `.env.example` in the repo documents every variable.
- **Filesystem abstraction is one variable.** `DATABASE_PATH` is the only filesystem touchpoint. On Railway it points at a volume mount; on EC2 it points at an EBS-backed path or just `/var/lib/mm-slack-cb-pr-status/bot.sqlite`. Nothing else writes to disk (logs go to stdout).
- **Logs to stdout/stderr only**, structured JSON (`pino`). Railway captures them today; CloudWatch, journald, or Loki capture them tomorrow with no code change.
- **No inbound networking assumptions** — already true by design (Socket Mode + polling are outbound-only), and worth preserving: if webhooks are added later, put the HTTP listener behind a feature flag so the outbound-only mode keeps working on hosts without ingress.
- **Graceful shutdown on SIGTERM/SIGINT**: close the Socket Mode connection, finish the in-flight poll cycle, close the SQLite handle. Both Railway and systemd/ECS send SIGTERM on redeploys; handling it properly means no half-applied reaction states.
- **Repo includes a `deploy/` directory** with a sample `systemd` unit file and a short RUNBOOK.md (how to provision a host, restore/backup the SQLite file, rotate tokens). Migrating later should be: copy the SQLite file, set env vars, start the container/unit.

The migration test to keep in mind: *"could we move this to a fresh EC2 instance in under 30 minutes with only the README?"* Every design choice should keep the answer yes.

## Railway deployment

- Single service from the GitHub repo, built **from the repo's Dockerfile** (see Portability requirements — Nixpacks works but ties the build to Railway).
- **Attach a Railway volume** mounted at `/data` and point `DATABASE_PATH` there. Railway's filesystem is ephemeral — without a volume the SQLite DB is wiped on every deploy, and the bot forgets every tracked PR.
- No public networking needed — do **not** expose a port/domain. All connections are outbound.
- Set restart policy to always; Bolt's Socket Mode client auto-reconnects on transient disconnects, and Railway restarts the process if it dies.
- Optional: a trivial healthcheck is awkward without HTTP; rely on Railway's process supervision + structured logs (`pino`) for observability. Log every state transition and reaction call.

## Edge cases to handle

- PR link posted for an **already-merged** PR → first poll resolves it immediately; apply merged emoji once, then stop tracking after TTL.
- Same PR posted twice in the channel → both messages tracked and updated (one-to-many model covers this).
- Message **edited** to add a PR link → `link_shared` fires for edits too; upsert handles it.
- Message **deleted** → `message_not_found` on reaction call → drop the `pr_messages` row.
- Bot restarts → all state is in SQLite; next poll cycle self-heals reactions via reconciliation.
- Approval revoked / changes requested after approval → latest-review-per-user logic naturally moves state backward (e.g. `approved` → `partial`); reconciler handles downgrades the same as upgrades.
- Draft PRs → tracked like any open PR (0 approvals → no emoji). Optionally add a distinct draft emoji later.

## Milestones

1. **Skeleton** — Bolt Socket Mode app connects, logs `link_shared` events, PR link parser + unit tests.
2. **Persistence** — Drizzle schema, upsert/query layer, channel allowlist.
3. **GitHub poller** — Octokit client, latest-review-per-user approval counting, state machine + unit tests.
4. **Reconciler** — reaction add/remove with error handling; end-to-end works locally against real workspace + a test repo.
5. **Deploy** — multi-stage Dockerfile, `.env.example`, SIGTERM handling, Railway volume + env vars. Ship it.
6. **Polish** — cleanup TTL job, closed-without-merge emoji, README, `deploy/` dir (systemd unit + RUNBOOK.md for future migration).

Rough effort: milestones 1–4 are a focused day; 5–6 a half day.

## Future ideas (explicitly out of scope for v1)

- GitHub webhooks (`pull_request_review`, `pull_request`) for instant updates — requires a public endpoint on Railway + signature verification; polling remains as a fallback reconciler.
- Read required-approval count from branch protection instead of env var.
- "Changes requested" as its own emoji state.
- Thread reply from the bot when a PR sits unreviewed for > N hours (gentle nudge).
- Slash command `/pr-status` to list all currently-tracked open PRs.