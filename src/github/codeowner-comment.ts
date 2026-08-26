import type { CodeownerStatus, CodeownerRequirement } from '../types.js';

const SATISFIED_MARKER = '✅'; // ✅
const HEADER = 'Codeowners approval required for this PR:';
const ALL_SATISFIED_BODY = 'Codeowners reviews satisfied';
const TEAM_RE = /@[\w.-]+\/([\w.-]+)/g;
const MINIMUM_RE = /Need (\d+) reviews?, found (\d+)/;
const IGNORED_LINES = new Set(['Show detailed file reviewers']);

/**
 * Parses a comment body from the codeowner bot into structured status.
 *
 * Returns null if the body is not a recognized codeowner status comment,
 * so the caller can skip non-codeowner comments without special casing.
 */
export function parseCodeownerComment(body: string): CodeownerStatus | null {
  const trimmed = body.trim();

  if (trimmed === ALL_SATISFIED_BODY) {
    return { requirements: [], minimum: null, allSatisfied: true };
  }

  if (!trimmed.includes(HEADER)) return null;

  const requirements: CodeownerRequirement[] = [];
  let minimum: CodeownerStatus['minimum'] = null;

  for (const raw of trimmed.split('\n')) {
    const line = raw.trim();
    if (!line || line === HEADER || IGNORED_LINES.has(line)) continue;

    const minMatch = MINIMUM_RE.exec(line);
    if (minMatch) {
      const required = parseInt(minMatch[1]!, 10);
      const found = parseInt(minMatch[2]!, 10);
      minimum = { required, found, met: found >= required };
      continue;
    }

    // Collect all @org/team slugs on this line
    const slugs: string[] = [];
    for (const match of line.matchAll(TEAM_RE)) {
      if (match[1]) slugs.push(match[1]);
    }
    if (slugs.length === 0) continue;

    const satisfied = line.startsWith(SATISFIED_MARKER);
    requirements.push({ teams: slugs, satisfied });
  }

  const allSatisfied = requirements.length > 0 && requirements.every((r) => r.satisfied)
    && (minimum === null || minimum.met);

  return { requirements, minimum, allSatisfied };
}
