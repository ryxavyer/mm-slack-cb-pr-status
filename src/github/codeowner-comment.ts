import type { CodeownerRequirement, CodeownerStatus } from '../types.js';

/**
 * The comment body arrives as markdown source, and the bot is free to change how
 * it lays that markdown out. So nothing here anchors on layout: a requirement is
 * recognised by the team it names and the tick beside it, wherever on the line
 * those fall. List markers, bold, blockquotes, table cells and indentation all
 * pass through untouched, because none of them are looked at.
 *
 * The one previous version of this that anchored on layout — `startsWith('✅')`,
 * which a `- ` list marker defeats — read every satisfied requirement as
 * outstanding, and did it while a full test suite passed against fixtures
 * written in a format the bot never emits.
 */

/** The tick the bot puts beside a requirement that has been signed off. */
const SATISFIED_MARKER = '✅';

/** `@org/team`, capturing the team slug. */
const TEAM_RE = /@[\w.-]+\/([\w.-]+)/g;

/** Recognisers for the comment as a whole, kept loose on wording and spacing. */
const ALL_SATISFIED_RE = /codeowners?\s+reviews?\s+satisfied/i;
const HEADER_RE = /codeowners?\s+approval\s+required/i;

/** "Minimum review requirement not met. Need 2 reviews, found 1." */
const MINIMUM_RE = /need\s+(\d+)\s+reviews?,\s*found\s+(\d+)/i;

/**
 * The bot appends a collapsed per-file breakdown. It repeats the same teams
 * against individual files, so parsing it would invent duplicate requirements
 * that no tick is ever attached to — leaving a fully approved PR looking
 * permanently outstanding. Requirements live above it; everything from here down
 * is supplementary.
 */
const DETAILS_RE = /<details/i;

/**
 * Parses a comment body from the codeowner bot into structured status.
 *
 * Returns null if the body is not a recognized codeowner status comment,
 * so the caller can skip non-codeowner comments without special casing.
 */
export function parseCodeownerComment(body: string): CodeownerStatus | null {
  if (!body.trim()) return null;

  // The bot edits one comment in place, so the all-clear can arrive on its own
  // or replace the list under the header it originally posted. Either way it
  // settles the question and there is nothing left to itemise.
  if (ALL_SATISFIED_RE.test(body)) {
    return { requirements: [], minimum: null, allSatisfied: true };
  }

  if (!HEADER_RE.test(body)) return null;

  const requirements: CodeownerRequirement[] = [];
  let minimum: CodeownerStatus['minimum'] = null;

  for (const line of body.split('\n')) {
    if (DETAILS_RE.test(line)) break;

    const minMatch = MINIMUM_RE.exec(line);
    if (minMatch) {
      const required = parseInt(minMatch[1]!, 10);
      const found = parseInt(minMatch[2]!, 10);
      minimum = { required, found, met: found >= required };
      continue;
    }

    // Every team named on this line. More than one means an OR group.
    const teams: string[] = [];
    for (const match of line.matchAll(TEAM_RE)) {
      if (match[1]) teams.push(match[1]);
    }
    if (teams.length === 0) continue;

    requirements.push({ teams, satisfied: line.includes(SATISFIED_MARKER) });
  }

  const allSatisfied =
    requirements.length > 0 &&
    requirements.every((r) => r.satisfied) &&
    (minimum === null || minimum.met);

  return { requirements, minimum, allSatisfied };
}
