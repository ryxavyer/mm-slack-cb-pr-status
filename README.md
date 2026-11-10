# mm-slack-cb-pr-status

A Slack bot that watches a review channel for GitHub PR links and keeps an emoji
on each message reflecting the PR's current review state — so the team can see at
a glance what still needs eyes, without anyone managing reactions by hand.

Approval is never counted by the bot. It reflects the codeowner bot
(`mmllc-gh`) and its comment on the PR, which is the source of truth for whether
a PR is ready to merge.

Each message carries one emoji. A channel with no team set shows the PR as a
whole; a channel set to a GitHub team also shows that team's part in it:

| Situation (from the codeowner bot's comment and GitHub)                     | No team set          | Channel set to a team |
| --------------------------------------------------------------------------- | -------------------- | --------------------- |
| Nobody has reviewed yet (the author's, bots' and the codeowner bot's don't count) | `:please:` (custom) | `:please:`          |
| Someone reviewed; the team is listed but its line isn't ticked              | *(none)*             | `:please:`            |
| The team's line is ticked; other code owners still outstanding              | *(none)*             | `:codeowner-approved-large:` (custom) |
| The team's line is ticked; nothing else outstanding; "found 1 of 2"         | *(none)*             | `:1of2:` (custom)     |
| Someone reviewed; the team isn't listed, or the codeowner bot hasn't commented | *(none)*          | *(none)*              |
| The codeowner bot says the whole PR is satisfied                            | `:white_check_mark:` | `:white_check_mark:`  |
| A reviewer's latest review requests changes                                 | `:request-changes:`  | `:request-changes:`   |
| Merged / closed without merge                                               | `:merged:` (custom) / `:x:` | `:merged:` / `:x:` |
| GitHub stopped answering (token expired, repo gone)                         | `:sleeping:`         | `:sleeping:`          |

The last three rows outrank everything else. A ticked line includes an "or" line
another team satisfied: the codeowner bot no longer needs this team for it.

`:white_check_mark:` means the same thing everywhere: ready to merge.
`:codeowner-approved-large:` only ever speaks for the channel's own team — other code
owners may still be needed. When a message links several PRs, it shows the one
furthest from done.

Any channel, public or private, can be set to a team by posting a message that
starts with the bot's mention:

```
@CB PR Status team creator-team     ← GitHub team slug; org/ prefix optional
@CB PR Status team none             ← back to no team
```

The slug is the team's name as the codeowner bot writes it (`@multimediallc/creator-team`
→ `creator-team`). The bot reacts `:ok_hand:` when it's saved and `:question:` if it
couldn't read the message. It can't check the slug against GitHub, so a typo is
saved too, and the channel then never shows team progress.

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
