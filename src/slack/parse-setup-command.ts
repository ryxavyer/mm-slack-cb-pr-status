/**
 * A channel setup message addressed to the bot. The bot has no slash commands
 * (that would need a Slack app config change), so setup is a plain message that
 * starts by @-mentioning it:
 *
 *   @CB PR Status team creator-team     → this channel represents that GitHub team
 *   @CB PR Status team multimediallc/creator-team   (org prefix is ignored)
 *   @CB PR Status team monetization-team creator-team   → several teams
 *   @CB PR Status team none             → back to the whole-PR view
 *
 * Each command replaces the channel's whole list; an empty list clears it.
 */
export type SetupCommand = { kind: 'set_teams'; teams: string[] } | { kind: 'invalid' };

/** Slack encodes a user mention as <@U123> or, from some clients, <@U123|name>. */
const LEADING_MENTION_RE = /^\s*<@([A-Z0-9]+)(?:\|[^>]*)?>\s*(.*)$/s;
const TEAMS_RE = /^team\s+(.+)$/i;
const SLUG_RE = /^@?(?:[\w.-]+\/)?([\w.-]+)$/;
const CLEAR_WORDS = new Set(['none', 'off', 'clear']);

/**
 * Null when the message isn't addressed to the bot — it must *start* with the
 * mention, so a passing "thanks @CB PR Status" is never read as setup.
 */
export function parseSetupCommand(text: string, botUserId: string): SetupCommand | null {
  const mention = LEADING_MENTION_RE.exec(text);
  if (!mention || mention[1] !== botUserId) return null;

  const list = TEAMS_RE.exec(mention[2]!.trim())?.[1];
  if (!list) return { kind: 'invalid' };

  // Teams are separated by spaces, commas or both.
  const teams: string[] = [];
  for (const word of list.split(/[\s,]+/).filter(Boolean)) {
    const team = SLUG_RE.exec(word)?.[1]?.toLowerCase();
    if (!team) return { kind: 'invalid' };
    if (!teams.includes(team)) teams.push(team);
  }
  if (teams.length === 1 && CLEAR_WORDS.has(teams[0]!)) return { kind: 'set_teams', teams: [] };
  if (teams.some((t) => CLEAR_WORDS.has(t))) return { kind: 'invalid' };
  return { kind: 'set_teams', teams };
}
