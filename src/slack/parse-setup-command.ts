/**
 * A channel setup message addressed to the bot. The bot has no slash commands
 * (that would need a Slack app config change), so setup is a plain message that
 * starts by @-mentioning it:
 *
 *   @CB PR Status team creator-team     → this channel represents that GitHub team
 *   @CB PR Status team multimediallc/creator-team   (org prefix is ignored)
 *   @CB PR Status team none             → back to the whole-PR view
 */
export type SetupCommand = { kind: 'set_team'; team: string | null } | { kind: 'invalid' };

/** Slack encodes a user mention as <@U123> or, from some clients, <@U123|name>. */
const LEADING_MENTION_RE = /^\s*<@([A-Z0-9]+)(?:\|[^>]*)?>\s*(.*)$/s;
const TEAM_RE = /^team\s+@?(?:[\w.-]+\/)?([\w.-]+)$/i;
const CLEAR_WORDS = new Set(['none', 'off', 'clear']);

/**
 * Null when the message isn't addressed to the bot — it must *start* with the
 * mention, so a passing "thanks @CB PR Status" is never read as setup.
 */
export function parseSetupCommand(text: string, botUserId: string): SetupCommand | null {
  const mention = LEADING_MENTION_RE.exec(text);
  if (!mention || mention[1] !== botUserId) return null;

  const team = TEAM_RE.exec(mention[2]!.trim())?.[1]?.toLowerCase();
  if (!team) return { kind: 'invalid' };
  return { kind: 'set_team', team: CLEAR_WORDS.has(team) ? null : team };
}
