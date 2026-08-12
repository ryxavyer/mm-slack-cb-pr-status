import type { PrRef } from '../types.js';

/**
 * Matches a GitHub PR URL anywhere in a blob of text.
 *
 * Deliberately permissive about what follows the PR number so that
 * `/files`, `/commits/abc`, `#discussion_r1`, `?w=1` and Slack's
 * `<url|label>` / `<url>` wrappers all parse. The boundary check after
 * `(\d+)` is what stops `/pull/12345-something` from matching as PR 12345.
 */
const PR_URL_RE =
  /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+?)\/pull\/(\d+)(?![\d-])/g;

/**
 * Extracts every distinct GitHub PR referenced in `text`.
 *
 * Owner and repo are lower-cased: GitHub treats them case-insensitively, so
 * normalising here keeps the (owner, repo, number) unique index from splitting
 * `Acme/App#1` and `acme/app#1` into two tracked rows.
 */
export function parsePrLinks(text: string | undefined | null): PrRef[] {
  if (!text) return [];

  const seen = new Set<string>();
  const refs: PrRef[] = [];

  for (const match of text.matchAll(PR_URL_RE)) {
    const [, owner, rawRepo, rawNumber] = match;
    if (!owner || !rawRepo || !rawNumber) continue;

    // Trailing dots are punctuation ("see .../pull/5."), never part of a repo name.
    const repo = rawRepo.replace(/\.+$/, '');
    if (repo === '' || repo === '.git') continue;

    const number = Number.parseInt(rawNumber, 10);
    if (!Number.isSafeInteger(number) || number <= 0) continue;

    const ref: PrRef = { owner: owner.toLowerCase(), repo: repo.toLowerCase(), number };
    const key = `${ref.owner}/${ref.repo}#${ref.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }

  return refs;
}
