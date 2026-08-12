# mm-slack-cb-pr-status

A Slack bot that watches a review channel for GitHub PR links and keeps an emoji
on each message reflecting the PR's current review state — so the team can see at
a glance what still needs eyes, without anyone managing reactions by hand.

| PR state             | Condition                                    | Reaction             |
| -------------------- | -------------------------------------------- | -------------------- |
| No reviews           | 0 approvals                                  | *(none)*             |
| Partially reviewed   | 1 approval (of 2 required)                   | `:eyes:`             |
| Fully approved       | approvals ≥ required                         | `:white_check_mark:` |
| Merged               | PR merged                                    | `:merged:` (custom)  |
| Closed without merge | PR closed, not merged                        | `:x:`                |
| Unknown              | GitHub access broken — token expired, repo gone | `:sleeping:`      |

Every emoji is configurable. The bot only ever adds or removes emoji from this
managed set, one at a time per message; reactions added by people are never
touched.

Setup, configuration and operations live in
[deploy/RUNBOOK.md](deploy/RUNBOOK.md) and [.env.example](.env.example).

## Future work

- GitHub webhooks for instant updates (needs a public endpoint; polling would
  stay as the fallback reconciler).
- Reading the required-approval count from branch protection rules instead of the
  `REQUIRED_APPROVALS` env var.
- "Changes requested" as its own emoji state.
- A nudge reply when a PR sits unreviewed for more than N hours.
- A `/pr-status` slash command listing tracked open PRs.
