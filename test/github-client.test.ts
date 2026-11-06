import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyError, OctokitGitHubClient, PrUnreachableError } from '../src/github/client.js';
import type { PrRef } from '../src/types.js';

/**
 * Octokit replaced by a stand-in serving whatever `github` holds: the PR, its
 * reviews and its issue comments, or an error for any request.
 */
const github = vi.hoisted(() => ({
  pr: {} as Record<string, unknown>,
  reviews: [] as unknown[],
  comments: [] as unknown[],
  error: null as Error | null,
}));

vi.mock('octokit', () => ({
  Octokit: class {
    private serve<T>(data: T): Promise<T> {
      return github.error ? Promise.reject(github.error) : Promise.resolve(data);
    }
    rest = {
      pulls: {
        get: () => this.serve({ data: github.pr }),
        listReviews: () => this.serve(github.reviews),
      },
      issues: { listComments: () => this.serve(github.comments) },
    };
    paginate(list: () => Promise<unknown[]>) {
      return list();
    }
  },
}));

/** Builds an error shaped like an Octokit RequestError. */
function requestError(status: number, headers: Record<string, string> = {}, message = 'error') {
  return Object.assign(new Error(message), { status, response: { headers } });
}

describe('classifyError', () => {
  it('classifies a dead or revoked token as unauthorized', () => {
    expect(classifyError(requestError(401))).toBe('unauthorized');
  });

  it('classifies a permission failure as forbidden', () => {
    expect(classifyError(requestError(403, {}, 'Resource not accessible by personal access token'))).toBe(
      'forbidden',
    );
  });

  it('classifies a missing repo or PR as not_found', () => {
    expect(classifyError(requestError(404))).toBe('not_found');
  });

  it('classifies an SSO-authorisation demand as forbidden, not transient', () => {
    // GitHub returns 403 with this header when a token needs SSO authorisation
    // for the org — an access problem the operator must fix.
    const error = requestError(403, {
      'x-github-sso': 'required; url=https://github.com/orgs/acme/sso',
      'x-ratelimit-remaining': '0',
    });
    expect(classifyError(error)).toBe('forbidden');
  });

  it('treats rate limiting as transient, not an access failure', () => {
    // Critical: a throttle must not flip every tracked PR to :sleeping:.
    expect(classifyError(requestError(403, { 'x-ratelimit-remaining': '0' }))).toBeNull();
    expect(classifyError(requestError(429, { 'retry-after': '60' }))).toBeNull();
    expect(
      classifyError(requestError(403, {}, 'You have exceeded a secondary rate limit')),
    ).toBeNull();
  });

  it('treats server and network errors as transient', () => {
    expect(classifyError(requestError(500))).toBeNull();
    expect(classifyError(requestError(502))).toBeNull();
    expect(classifyError(new Error('ECONNRESET'))).toBeNull();
    expect(classifyError(undefined)).toBeNull();
  });

  it('reads headers whether octokit puts them on the error or the response', () => {
    const onError = Object.assign(new Error('rate limited'), {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0' },
    });
    expect(classifyError(onError)).toBeNull();
  });
});

describe('OctokitGitHubClient', () => {
  const ref: PrRef = { owner: 'acme', repo: 'monolith', number: 42 };
  const client = new OctokitGitHubClient({ token: 'ghp-test' });
  const author = { id: 100, login: 'author', type: 'User' };
  const user = (id: number, login = `user${id}`, type = 'User') => ({ id, login, type });

  const review = (reviewer: ReturnType<typeof user>, state: string, at = '2026-08-01T10:00:00Z') => ({
    user: reviewer,
    state,
    submitted_at: at,
  });

  const comment = (login: string, body: string) => ({ user: { login }, body });

  beforeEach(() => {
    github.pr = { state: 'open', merged: false, user: author, requested_reviewers: [], title: 'A PR' };
    github.reviews = [];
    github.comments = [];
    github.error = null;
  });

  describe('fetchCodeownerStatus', () => {
    it('reads the codeowner bot’s comment', async () => {
      github.comments = [comment('mmllc-gh', 'Codeowners reviews satisfied')];
      expect(await client.fetchCodeownerStatus(ref, 'mmllc-gh')).toMatchObject({ allSatisfied: true });
    });

    it('never trusts the same words from anyone else', async () => {
      github.comments = [
        comment('mmllc-gh', 'Codeowners approval required for this PR:\n- @multimediallc/creator-team'),
        comment('someone', 'Codeowners reviews satisfied'),
      ];

      expect(await client.fetchCodeownerStatus(ref, 'mmllc-gh')).toMatchObject({ allSatisfied: false });

      github.comments = [comment('someone', 'Codeowners reviews satisfied')];
      expect(await client.fetchCodeownerStatus(ref, 'mmllc-gh')).toBeNull();
    });

    it('matches the bot login case-insensitively', async () => {
      github.comments = [comment('MMLLC-GH', 'Codeowners reviews satisfied')];
      expect(await client.fetchCodeownerStatus(ref, 'mmllc-gh')).toMatchObject({ allSatisfied: true });
    });

    it('takes the bot’s latest status comment, skipping its other comments', async () => {
      github.comments = [
        comment('mmllc-gh', 'Codeowners approval required for this PR:\n- @multimediallc/creator-team'),
        comment('mmllc-gh', 'Codeowners reviews satisfied'),
        comment('mmllc-gh', 'Thanks for the PR!'),
      ];
      expect(await client.fetchCodeownerStatus(ref, 'mmllc-gh')).toMatchObject({ allSatisfied: true });
    });

    it('is null when the bot has not commented', async () => {
      expect(await client.fetchCodeownerStatus(ref, 'mmllc-gh')).toBeNull();
    });

    it('is null when GitHub refuses access, and rethrows a transient error', async () => {
      github.error = requestError(404);
      expect(await client.fetchCodeownerStatus(ref, 'mmllc-gh')).toBeNull();

      github.error = requestError(502);
      await expect(client.fetchCodeownerStatus(ref, 'mmllc-gh')).rejects.toBe(github.error);
    });
  });

  describe('fetchPrStatus', () => {
    it('reports an open PR nobody has reviewed', async () => {
      expect(await client.fetchPrStatus(ref)).toEqual({
        merged: false,
        closed: false,
        changesRequested: 0,
        reviewed: false,
        title: 'A PR',
      });
    });

    it('reports merged and closed', async () => {
      github.pr = { ...github.pr, state: 'closed', merged: true };
      expect(await client.fetchPrStatus(ref)).toMatchObject({ merged: true, closed: true });

      github.pr = { ...github.pr, state: 'closed', merged: false };
      expect(await client.fetchPrStatus(ref)).toMatchObject({ merged: false, closed: true });
    });

    it('counts blocking reviews, but not from a reviewer asked to look again', async () => {
      github.reviews = [review(user(1), 'CHANGES_REQUESTED'), review(user(2), 'CHANGES_REQUESTED')];
      expect(await client.fetchPrStatus(ref)).toMatchObject({ changesRequested: 2 });

      github.pr = { ...github.pr, requested_reviewers: [user(1)] };
      expect(await client.fetchPrStatus(ref)).toMatchObject({ changesRequested: 1 });
    });

    it('does not count reviews by the author, bots or the ignored logins as reviewed', async () => {
      github.reviews = [
        review(author, 'COMMENTED'),
        review(user(7, 'copilot', 'Bot'), 'COMMENTED'),
        review(user(8, 'mmllc-gh'), 'APPROVED'),
      ];
      expect(await client.fetchPrStatus(ref, ['mmllc-gh'])).toMatchObject({ reviewed: false });

      github.reviews.push(review(user(1), 'COMMENTED'));
      expect(await client.fetchPrStatus(ref, ['mmllc-gh'])).toMatchObject({ reviewed: true });
    });

    it('throws PrUnreachableError when GitHub refuses access', async () => {
      github.error = requestError(404);
      const error = await client.fetchPrStatus(ref).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PrUnreachableError);
      expect(error).toMatchObject({ reason: 'not_found', status: 404, ref });
    });

    it('rethrows a transient error untouched', async () => {
      github.error = requestError(502);
      await expect(client.fetchPrStatus(ref)).rejects.toBe(github.error);
    });
  });
});
