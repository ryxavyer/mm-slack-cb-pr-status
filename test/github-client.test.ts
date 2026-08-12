import { describe, expect, it } from 'vitest';
import { classifyError } from '../src/github/client.js';

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
