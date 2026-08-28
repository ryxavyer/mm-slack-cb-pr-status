/**
 * Prints the full derivation of a PR's emoji, from the GitHub API down to the
 * reaction the bot would apply. Use it when a message shows an emoji you did not
 * expect: it shows every input the decision is made from, so you can see which
 * one disagrees with what GitHub's UI is telling you.
 *
 *   GITHUB_TOKEN=ghp_... npx tsx scripts/diagnose-pr.ts <pr-url> [team-slug]
 *
 * Reads GITHUB_TOKEN, and optionally REQUIRED_APPROVALS (default 2) and
 * TEAM_MAP_FILE (default ./team-map.json). Read-only — it never touches Slack
 * or the database.
 */
import { readFileSync } from 'node:fs';
import { Octokit } from 'octokit';
import type { EmojiConfig } from '../src/config.js';
import type { TrackedPr } from '../src/db/schema.js';
import { parseCodeownerComment } from '../src/github/codeowner-comment.js';
import { latestReviewByReviewer, summariseReviews } from '../src/github/reviews.js';
import { computeCodeownerState, computeState, emojiForState } from '../src/state.js';

const emoji: EmojiConfig = {
  changesRequested: process.env['EMOJI_CHANGES_REQUESTED'] ?? 'request-changes',
  partial: process.env['EMOJI_PARTIAL'] ?? '1of2',
  approved: process.env['EMOJI_APPROVED'] ?? 'white_check_mark',
  merged: process.env['EMOJI_MERGED'] ?? 'merged',
  closed: process.env['EMOJI_CLOSED'] ?? 'x',
  unknown: process.env['EMOJI_UNKNOWN'] ?? 'sleeping',
};

const [, , url, teamArg] = process.argv;
if (!url) {
  console.error('usage: npx tsx scripts/diagnose-pr.ts <pr-url> [team-slug]');
  process.exit(1);
}

const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
if (!match) {
  console.error(`not a PR url: ${url}`);
  process.exit(1);
}
const [, owner, repo, numberRaw] = match as unknown as [string, string, string, string];
const number = Number(numberRaw);

const token = process.env['GITHUB_TOKEN'];
if (!token) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}

const requiredApprovals = Number(process.env['REQUIRED_APPROVALS'] ?? 2);
const teamMapFile = process.env['TEAM_MAP_FILE'] ?? 'team-map.json';

let botLogin = 'mmllc-gh';
try {
  botLogin = JSON.parse(readFileSync(teamMapFile, 'utf-8')).botLogin ?? botLogin;
} catch {
  console.log(`! could not read ${teamMapFile}; assuming botLogin=${botLogin}`);
}

const octokit = new Octokit({
  auth: token,
  baseUrl: process.env['GITHUB_API_BASE_URL'] ?? 'https://api.github.com',
});

const heading = (text: string) => console.log(`\n== ${text} ==`);

const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
  owner,
  repo,
  pull_number: number,
  per_page: 100,
});

heading(`${owner}/${repo}#${number} - ${pr.title}`);
console.log(
  `merged=${Boolean(pr.merged ?? pr.merged_at)} closed=${pr.state === 'closed'} draft=${Boolean(pr.draft)}`,
);

heading('reviews (every submission, oldest first)');
for (const r of reviews) {
  const when = r.submitted_at ?? '(no timestamp)';
  console.log(`  ${when}  ${(r.state ?? '?').padEnd(17)} ${r.user?.login ?? '(unknown user)'}`);
}
if (reviews.length === 0) console.log('  (none)');

heading('each reviewer current position (COMMENTED/PENDING dropped)');
const positions = latestReviewByReviewer(reviews);
for (const [key, position] of positions) console.log(`  ${key.padEnd(28)} ${position}`);
if (positions.size === 0) console.log('  (none)');

const summary = summariseReviews(reviews);
const merged = Boolean(pr.merged ?? pr.merged_at);
const closed = pr.state === 'closed';
const state = computeState({
  merged,
  closed,
  approvals: summary.approvals,
  changesRequested: summary.changesRequested,
  requiredApprovals,
});

// merged/closed outrank the review state, which would hide the very thing we
// are diagnosing on a PR that has since been merged.
const reviewState = computeState({
  merged: false,
  closed: false,
  approvals: summary.approvals,
  changesRequested: summary.changesRequested,
  requiredApprovals,
});

heading('approval count');
console.log(
  `  approvals=${summary.approvals} changesRequested=${summary.changesRequested} requiredApprovals=${requiredApprovals}`,
);
console.log(`  -> computeState = ${state}`);
if (merged || closed) {
  console.log(`  -> ignoring merged/closed, the review state is ${reviewState}`);
}

heading(`codeowner comments (looking for a comment by "${botLogin}")`);
const comments = await octokit.paginate(octokit.rest.issues.listComments, {
  owner,
  repo,
  issue_number: number,
  per_page: 100,
});
console.log(`  ${comments.length} issue comment(s) on this PR`);
for (const c of comments) {
  const login = c.user?.login ?? '(unknown)';
  const isBot = login.toLowerCase() === botLogin.toLowerCase();
  const parsed = parseCodeownerComment(c.body ?? '');
  const firstLine = (c.body ?? '').trim().split('\n')[0] ?? '';
  console.log(
    `  ${isBot ? '->' : '  '} ${login.padEnd(22)} type=${c.user?.type ?? '?'} parses=${parsed ? 'yes' : 'NO '}  ${JSON.stringify(firstLine.slice(0, 60))}`,
  );
}

// The exact body of every comment by the bot. This is the datum that matters:
// the parser recognises the "all satisfied" case only by an exact match on the
// whole body, so any extra punctuation, markdown or emoji makes it return null.
const botComments = comments.filter(
  (c) => c.user?.login?.toLowerCase() === botLogin.toLowerCase(),
);
heading(`exact body of each comment by "${botLogin}" (oldest first)`);
if (botComments.length === 0) {
  console.log('  (none - the app will never have any codeowner status for this PR)');
}
for (const c of botComments) {
  const parsed = parseCodeownerComment(c.body ?? '');
  console.log(`  --- ${c.created_at} (edited: ${c.updated_at !== c.created_at}) ---`);
  console.log(`  parses=${parsed ? 'yes' : 'NO'}${parsed ? ` allSatisfied=${parsed.allSatisfied}` : ''}`);
  // JSON-quoted so trailing spaces, newlines and stray characters are visible.
  for (const line of (c.body ?? '').split('\n')) console.log(`    ${JSON.stringify(line)}`);
}

// Exactly what the app does: newest first, first comment by botLogin that parses.
let codeownerStatus: string | null = null;
let usedComment: string | undefined;
for (const c of [...comments].reverse()) {
  if (c.user?.login?.toLowerCase() !== botLogin.toLowerCase()) continue;
  const parsed = parseCodeownerComment(c.body ?? '');
  if (parsed !== null) {
    codeownerStatus = JSON.stringify(parsed);
    usedComment = c.created_at;
    break;
  }
}

if (usedComment && botComments.length > 0 && usedComment !== botComments.at(-1)?.created_at) {
  console.log(
    `\n  ! the newest bot comment did not parse, so the app fell back to the one from ${usedComment}`,
  );
}

heading('codeowner status the app would store');
if (codeownerStatus === null) {
  console.log('  null  - no comment by that login parsed as a codeowner status');
  console.log('  (the emoji then comes from the approval count alone)');
} else {
  console.log(`  ${codeownerStatus}`);
}

const tracked = {
  id: 0,
  owner,
  repo,
  number,
  state,
  approvals: summary.approvals,
  requiredApprovals,
  lastPolledAt: null,
  createdAt: 0,
  closedAt: null,
  unreachableSince: null,
  codeownerStatus,
} satisfies TrackedPr;

heading('resulting emoji');
if (merged || closed) {
  console.log(`  (this PR is ${merged ? 'merged' : 'closed'}, which outranks everything below;`);
  console.log('   the states shown use the review state so the derivation stays visible)');
}
const forEmoji = { ...tracked, state: reviewState } satisfies TrackedPr;
const noTeam = computeCodeownerState(forEmoji);
console.log(
  `  channel with no team   -> ${noTeam.padEnd(18)} ${emojiForState(noTeam, emoji) ?? '(no reaction)'}`,
);
if (teamArg) {
  const withTeam = computeCodeownerState(forEmoji, teamArg);
  console.log(
    `  channel for ${teamArg.padEnd(10)} -> ${withTeam.padEnd(18)} ${emojiForState(withTeam, emoji) ?? '(no reaction)'}`,
  );
} else {
  console.log('  (pass a team slug as the second argument to see a team channel too)');
}
console.log();
