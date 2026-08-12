# Runbook

Operating and moving `mm-slack-cb-pr-status`. The design goal is that a fresh host
takes under 30 minutes with only this document: the bot is a single process, all
config is env vars, and all state is one SQLite file.

## What the process actually does

- Opens an **outbound** WebSocket to Slack (Socket Mode) and receives PR links.
- Makes **outbound** HTTPS calls to the GitHub REST API every
  `POLL_INTERVAL_SECONDS` for each tracked open PR.
- Writes to exactly one path on disk: `DATABASE_PATH`.
- Logs JSON to stdout/stderr and nowhere else.

No inbound ports. No load balancer. No public DNS. If a host can make outbound
HTTPS calls, it can run this.

## First-time setup

Do this once per workspace, before provisioning any host.

### 1. Slack app

Create the app from [slack-manifest.yml](../slack-manifest.yml) — api.slack.com/apps
→ **Create New App** → **From a manifest** → paste the file. Then:

1. **Basic Information → App-Level Tokens** → generate a token with
   `connections:write`. That is `SLACK_APP_TOKEN` (`xapp-…`).
2. **Install App** → install to the workspace (may need admin approval). That
   gives you `SLACK_BOT_TOKEN` (`xoxb-…`).
3. `/invite @CB PR Status` in each channel you want watched.
4. Create the custom `:merged:` emoji if the workspace doesn't have one — or
   point `EMOJI_MERGED` at one that exists.
5. Collect the channel IDs (channel details → the `C…` ID at the bottom) for
   `WATCHED_CHANNELS`.

Two notes on the manifest's scopes. `github.com` must stay in `unfurl_domains`
or Slack never delivers `link_shared`. And `channels:history` /
`message.channels` exist only for the text-scan fallback — drop them (along with
the `groups:*` pair, which is for private channels) if you run with
`ENABLE_MESSAGE_SCAN=false` and watch only public channels.

### 2. GitHub token

A fine-grained PAT with **read-only Pull requests** permission on the relevant
repos. If the org uses SAML SSO, authorise the token for the org — otherwise
every poll 404s and every tracked PR shows `:sleeping:`.

### 3. Configuration

Every variable is documented in [.env.example](../.env.example). Copy it, fill in
the tokens and channel IDs, and pass it to the container or install it as
`/etc/mm-slack-cb-pr-status.env` for systemd.

To run locally: `npm ci && npm run dev`, with `DATABASE_PATH=./data/bot.sqlite`.

## Provisioning a host from scratch

### Option A — Railway (the current host)

New Project → **Deploy from GitHub repo**. [railway.json](../railway.json) pins
the build to the Dockerfile, one replica, restart-always, and no app sleeping, so
the only console work left is:

1. **Attach a volume mounted at `/data`.** Volumes cannot be declared in
   `railway.json` — this is the one setup step config-as-code can't cover, and
   the one that matters most. Railway's filesystem is otherwise ephemeral: with
   no volume, the database is wiped on *every* redeploy and the bot forgets every
   PR it was tracking. The mount path must match `DATABASE_PATH`, which the image
   already defaults to `/data/bot.sqlite`.
2. **Set the variables** (Variables → Raw Editor, paste from `.env.example`).
3. **Don't generate a domain, and leave Healthcheck Path empty.** This process
   never listens on a port — a healthcheck would fail forever and Railway would
   restart a perfectly healthy bot in a loop.

The first build compiles `better-sqlite3` natively, so expect a few minutes.

Keep replicas at 1. Two instances would both hold Socket Mode connections and
both reconcile, producing duplicate reaction churn on every message.

### Option B — any other container host

```bash
docker build -t mm-slack-cb-pr-status .
docker run -d --name mm-slack-cb-pr-status \
  --restart unless-stopped \
  --env-file /etc/mm-slack-cb-pr-status.env \
  -v mmbot-data:/data \
  mm-slack-cb-pr-status
```

That is the whole deployment. Railway, ECS, Fly and a plain Docker host all run
this same image; only the volume and env plumbing differ.

### Option C — systemd on a VM

```bash
# 1. Node 22 and a service account
sudo apt-get update && sudo apt-get install -y nodejs npm git
sudo useradd --system --home /opt/mm-slack-cb-pr-status --shell /usr/sbin/nologin mmbot

# 2. Code + build
sudo git clone https://github.com/your-org/mm-slack-cb-pr-status /opt/mm-slack-cb-pr-status
cd /opt/mm-slack-cb-pr-status
sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
sudo chown -R mmbot:mmbot /opt/mm-slack-cb-pr-status

# 3. Secrets (root-owned, group-readable by the service account)
sudo install -m 0640 -o root -g mmbot .env.example /etc/mm-slack-cb-pr-status.env
sudo editor /etc/mm-slack-cb-pr-status.env   # fill in the real tokens

# 4. Service
sudo cp deploy/mm-slack-cb-pr-status.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mm-slack-cb-pr-status
journalctl -u mm-slack-cb-pr-status -f
```

`StateDirectory=` in the unit creates `/var/lib/mm-slack-cb-pr-status` with the
right ownership, which is where `DATABASE_PATH` points.

## Verifying a deploy

Startup logs one `starting mm-slack-cb-pr-status` line containing the resolved
configuration, then `socket mode connection established`, then a
`poll cycle complete` line every `POLL_INTERVAL_SECONDS`.

```bash
# container
docker logs -f mm-slack-cb-pr-status | jq .
# systemd
journalctl -u mm-slack-cb-pr-status -f -o cat | jq .
```

End-to-end smoke test: post a link to an open PR in a watched channel. Within a
few seconds the log should show `tracking pr link`, and the message should carry
the right emoji (none if the PR has no approvals yet — approve it and wait one
poll interval).

## Backup and restore

State is one SQLite file plus its WAL sidecar. Never copy it with `cp` while the
process is running — use SQLite's own backup, which is consistent under load:

```bash
# Container
docker exec mm-slack-cb-pr-status \
  node -e "require('better-sqlite3')(process.env.DATABASE_PATH).backup('/data/backup.sqlite')"
docker cp mm-slack-cb-pr-status:/data/backup.sqlite ./bot-$(date +%F).sqlite

# VM
sudo -u mmbot sqlite3 /var/lib/mm-slack-cb-pr-status/bot.sqlite \
  ".backup '/tmp/bot-$(date +%F).sqlite'"
```

Restore: stop the service, drop the file at `DATABASE_PATH` (delete any stale
`-wal`/`-shm` sidecars), start the service. Migrations run automatically on boot.

**Losing the database is recoverable, not fatal.** The bot forgets which
messages it was tracking, so old messages keep whatever emoji they had, and new
links are tracked from that point on. Re-posting a PR link re-tracks it.

## Migrating hosts

1. Stop the old process (SIGTERM — it drains the poll cycle and closes SQLite).
2. Back up the database file as above.
3. Provision the new host (any option above), copy the file to the new
   `DATABASE_PATH`, set the same env vars.
4. Start the new process, confirm `socket mode connection established`.

Only one instance may run at a time: two processes would both hold the socket
and both reconcile reactions, producing duplicate add/remove churn. Always stop
the old one first.

## Rotating tokens

| Token             | Where                                                       |
| ----------------- | ----------------------------------------------------------- |
| `SLACK_BOT_TOKEN` | api.slack.com/apps → OAuth & Permissions → reinstall the app |
| `SLACK_APP_TOKEN` | api.slack.com/apps → Basic Information → App-Level Tokens    |
| `GITHUB_TOKEN`    | github.com/settings/personal-access-tokens                   |

Update the env var and restart. No code change, no database change. If the org
uses SAML SSO, re-authorise the new GitHub token for the org.

A lapsed GitHub token is not silent and not destructive: tracked PRs move to
`:sleeping:` (see `EMOJI_UNKNOWN`) instead of being mislabelled as closed, and
they return to their real state on the first poll after the token works again —
provided you fix it within `UNREACHABLE_TTL_DAYS`, after which the bot removes
its reactions and stops tracking those PRs.

## Troubleshooting

| Symptom | Likely cause |
| ------- | ------------ |
| No emoji ever appears | Channel ID not in `WATCHED_CHANNELS`, or the bot was never `/invite`d into the channel |
| `emoji does not exist in this workspace` | `EMOJI_MERGED` names a custom emoji that hasn't been created |
| Every PR shows `:sleeping:` | `GITHUB_TOKEN` expired, was revoked, lost repo access, or isn't SSO-authorised. Look for `pr unreachable on github` lines — they carry the `reason` and HTTP `status`. Fix the token and the emoji correct themselves on the next poll; no restart needed |
| `poll cycle complete` with `failed > 0` | Transient GitHub errors; check the `poll failed for pr` lines |
| Tracked PRs forgotten after a redeploy | `DATABASE_PATH` isn't on a mounted volume |
| `unable to open database file` at startup | The mounted volume isn't writable by the app. The container entrypoint chowns it and drops to the `node` user, so this should only appear if the platform forces a non-root user — then pre-create the mount owned by UID 1000 |
| `previous poll cycle still running` | More tracked PRs than fit in one interval — raise `POLL_INTERVAL_SECONDS` |
| Duplicate reaction churn | Two instances running against the same workspace |

## Capacity

Each poll cycle makes ~2 GitHub requests per tracked open PR (the PR, plus a page
of reviews). At 20 open PRs on a 90-second interval that is ~1,600 requests/hour
against a 5,000/hour authenticated limit. If you ever approach it, raise
`POLL_INTERVAL_SECONDS` — the only cost is a slower emoji update.
