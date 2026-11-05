# mm-slack-cb-pr-status

A Slack bot that watches a review channel for GitHub PR links and keeps an emoji
on each message reflecting the PR's current review state — so the team can see at
a glance what still needs eyes, without anyone managing reactions by hand.

Approval is never counted by the bot. It reflects the codeowner bot
(`mmllc-gh`) and its comment on the PR, which is the source of truth for whether
a PR is ready to merge.

| State                | Condition                                              | Reaction                  | Where                        |
| -------------------- | ------------------------------------------------------ | ------------------------- | ---------------------------- |
| Waiting              | codeowner bot not satisfied, or hasn't commented       | `:please:` (custom)       | every channel                |
| Changes requested    | any reviewer blocking (outranks everything but merged/closed) | `:request-changes:` | every channel              |
| One of two reviews   | team's requirement met, bot reports "found 1 of 2"     | `:1of2:`                  | private channel set to a team |
| Team done            | team's requirement and the minimum met, others pending | `:blue_check_mark:` | private channel set to a team |
| Approved             | codeowner bot satisfied for the whole PR               | `:white_check_mark:`      | every channel                |
| Merged               | PR merged                                              | `:merged:` (custom)       | every channel                |
| Closed without merge | PR closed, not merged                                  | `:x:`                     | every channel                |
| Unknown              | GitHub access broken — token expired, repo gone        | `:sleeping:`              | every channel                |

`:white_check_mark:` means the same thing everywhere: ready to merge. In a public
channel nothing short of that is shown, because anyone can tag any team there and
a partial signal could tell a team it's off the hook when it isn't.

A private channel can opt in to its team's progress by posting a message that
starts with the bot's mention:

```
@CB PR Status team creator-team     ← GitHub team slug; org/ prefix optional
@CB PR Status team none             ← back to the whole-PR view
```

The bot reacts `:ok_hand:` when it's saved, `:no_entry:` in a public channel
(team settings only apply in private channels), and `:question:` if it couldn't
read the message.

Every emoji is configurable. The bot only ever adds or removes emoji from this
managed set, one at a time per message; reactions added by people are never
touched.

Setup, configuration and operations live in
[deploy/RUNBOOK.md](deploy/RUNBOOK.md) and [.env.example](.env.example).

## Future work

- GitHub webhooks for instant updates (needs a public endpoint; polling would
  stay as the fallback reconciler).
- A nudge reply when a PR sits unreviewed for more than N hours.
- A `/pr-status` slash command listing tracked open PRs.
