import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { OctokitGitHubClient, PrUnreachableError } from '../src/github/client.js';
import type { PrRef } from '../src/types.js';

/**
 * The real Octokit (retry, throttling and pagination included) against a
 * stand-in for GitHub's API that behaves as GitHub does for conditional
 * requests: an ETag on every response, a bodiless 304 when If-None-Match
 * still matches, and pages of `per_page` linked by a Link header.
 */
function fakeGitHub() {
  const resources = new Map<string, unknown>();
  const failures = new Map<string, number>();
  const log: { path: string; status: number; conditional: boolean }[] = [];

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const ifNoneMatch = new Headers(init?.headers).get('if-none-match');
    const record = (status: number) => log.push({ path: url.pathname, status, conditional: ifNoneMatch !== null });

    const failure = failures.get(url.pathname);
    if (failure) {
      record(failure);
      return Response.json({ message: 'nope' }, { status: failure });
    }

    let body = resources.get(url.pathname);
    if (body === undefined) {
      record(404);
      return Response.json({ message: 'Not Found' }, { status: 404 });
    }

    const headers: Record<string, string> = {};
    if (Array.isArray(body)) {
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      if (body.length > page * perPage) {
        const next = new URL(url);
        next.searchParams.set('page', String(page + 1));
        headers['link'] = `<${next}>; rel="next"`;
      }
      body = body.slice((page - 1) * perPage, page * perPage);
    }

    const etag = `W/"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
    if (ifNoneMatch === etag) {
      record(304);
      return new Response(null, { status: 304, headers: { etag } });
    }
    record(200);
    return Response.json(body, { status: 200, headers: { ...headers, etag } });
  };

  return { resources, failures, log, fetch };
}

const ref: PrRef = { owner: 'acme', repo: 'monolith', number: 42 };
const PR = '/repos/acme/monolith/pulls/42';
const REVIEWS = '/repos/acme/monolith/pulls/42/reviews';
const COMMENTS = '/repos/acme/monolith/issues/42/comments';

const author = { id: 100, login: 'author', type: 'User' };
const alice = { id: 1, login: 'alice', type: 'User' };
const review = (state: string) => ({ user: alice, state, submitted_at: '2026-08-01T10:00:00Z' });
const comment = (login: string, body: string) => ({ user: { login }, body });
const REQUIRED = 'Codeowners approval required for this PR:\n- @multimediallc/creator-team';
const SATISFIED = 'Codeowners reviews satisfied';

describe('conditional GitHub requests', () => {
  let github: ReturnType<typeof fakeGitHub>;
  let client: OctokitGitHubClient;

  /** One poll, as PrService does it. */
  const poll = async () => ({
    pr: await client.fetchPrStatus(ref, ['mmllc-gh']),
    codeowners: await client.fetchCodeownerStatus(ref, 'mmllc-gh'),
  });

  const statuses = () => github.log.map((r) => r.status);

  beforeEach(() => {
    github = fakeGitHub();
    github.resources.set(PR, { state: 'open', merged: false, user: author, requested_reviewers: [], title: 'A PR' });
    github.resources.set(REVIEWS, []);
    github.resources.set(COMMENTS, [comment('mmllc-gh', REQUIRED)]);
    client = new OctokitGitHubClient({ token: 'ghp-test', fetch: github.fetch });
  });

  it('asks again with the ETag and reuses the answer when nothing changed', async () => {
    const first = await poll();
    github.log.length = 0;

    expect(await poll()).toEqual(first);
    expect(github.log).toEqual([
      { path: PR, status: 304, conditional: true },
      { path: REVIEWS, status: 304, conditional: true },
      { path: COMMENTS, status: 304, conditional: true },
    ]);
  });

  it('counts requests and unchanged answers for the poll summary', async () => {
    await poll();
    await poll();
    expect(client.takeRequestStats()).toEqual({ requests: 6, notModified: 3 });
    expect(client.takeRequestStats()).toEqual({ requests: 0, notModified: 0 });
  });

  it('sees a new review and a new codeowner comment as soon as they land', async () => {
    await poll();
    github.resources.set(REVIEWS, [review('APPROVED')]);
    github.resources.set(COMMENTS, [comment('mmllc-gh', REQUIRED), comment('mmllc-gh', SATISFIED)]);
    github.log.length = 0;

    const after = await poll();
    expect(after.pr.reviewed).toBe(true);
    expect(after.codeowners).toMatchObject({ allSatisfied: true });
    expect(statuses()).toEqual([304, 200, 200]);
  });

  it('sees a PR merged, and changes requested', async () => {
    await poll();
    github.resources.set(PR, { state: 'closed', merged: true, user: author, requested_reviewers: [], title: 'A PR' });
    github.resources.set(REVIEWS, [review('CHANGES_REQUESTED')]);

    expect((await poll()).pr).toMatchObject({ merged: true, closed: true, changesRequested: 1 });
  });

  it('keeps answering from the cache across many polls', async () => {
    await poll();
    for (let i = 0; i < 5; i++) await poll();
    expect(statuses().filter((s) => s === 200)).toHaveLength(3);
  });

  it('always fetches a full page in full, and finds the page that grows after it', async () => {
    const chatter = Array.from({ length: 99 }, (_, i) => comment(`user${i}`, 'lgtm'));
    github.resources.set(COMMENTS, [comment('mmllc-gh', REQUIRED), ...chatter]);
    await poll();

    // A 101st comment starts page two. Page one is unchanged, so a 304 on it
    // would hide the new page; it must be fetched again in full.
    github.resources.set(COMMENTS, [comment('mmllc-gh', REQUIRED), ...chatter, comment('mmllc-gh', SATISFIED)]);
    github.log.length = 0;

    expect((await poll()).codeowners).toMatchObject({ allSatisfied: true });
    const comments = github.log.filter((r) => r.path === COMMENTS);
    expect(comments).toEqual([
      { path: COMMENTS, status: 200, conditional: false },
      { path: COMMENTS, status: 200, conditional: false },
    ]);
  });

  it('still reports lost access after answers were cached', async () => {
    await poll();
    github.failures.set(PR, 404);

    const error = await client.fetchPrStatus(ref).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrUnreachableError);
    expect(error).toMatchObject({ reason: 'not_found' });
  });

  it('serves the cached answer after access returns', async () => {
    const first = await poll();
    github.failures.set(PR, 404);
    await client.fetchPrStatus(ref).catch(() => undefined);
    github.failures.delete(PR);

    expect(await poll()).toEqual(first);
  });
});
