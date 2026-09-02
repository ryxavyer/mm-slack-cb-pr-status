import { Octokit } from 'octokit';
import type { CodeownerStatus, PrRef } from '../types.js';
import { parseCodeownerComment } from './codeowner-comment.js';
import { summariseReviews } from './reviews.js';

/** What a poll needs to know about a PR. */
export interface PrStatus {
  merged: boolean;
  closed: boolean;
  draft: boolean;
  approvals: number;
  /** Reviewers currently blocking the PR with a changes-requested review. */
  changesRequested: number;
  title: string;
}

/** Why GitHub will not tell us about a PR. */
export type UnreachableReason =
  /** 404 — deleted or renamed repo, or a token that cannot see a private repo. */
  | 'not_found'
  /** 401 — the token is invalid, expired or revoked. */
  | 'unauthorized'
  /** 403 — the token lacks the permission, or is not SSO-authorised for the org. */
  | 'forbidden';

/**
 * Thrown when GitHub will not report on a PR at all, as opposed to reporting
 * that it is closed. These are *not* interchangeable: a PR cannot be deleted on
 * GitHub, so a 404 nearly always means an access problem rather than a PR that
 * went away. Callers surface this as the `unknown` state instead of guessing.
 */
export class PrUnreachableError extends Error {
  constructor(
    readonly ref: PrRef,
    readonly reason: UnreachableReason,
    readonly status: number,
  ) {
    super(`PR unreachable (${reason}): ${ref.owner}/${ref.repo}#${ref.number}`);
    this.name = 'PrUnreachableError';
  }
}

export interface GitHubClient {
  fetchPrStatus(ref: PrRef): Promise<PrStatus>;
  fetchCodeownerStatus(ref: PrRef, botLogin: string): Promise<CodeownerStatus | null>;
}

function statusCode(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

function headers(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return {};
  const response = (error as { response?: { headers?: unknown } }).response;
  const fromResponse = response?.headers;
  if (fromResponse && typeof fromResponse === 'object') {
    return fromResponse as Record<string, unknown>;
  }
  const direct = (error as { headers?: unknown }).headers;
  return direct && typeof direct === 'object' ? (direct as Record<string, unknown>) : {};
}

/**
 * Rate limiting also arrives as a 403, but it says nothing about our access — it
 * is transient. Treating it as an auth failure would flip every tracked PR to
 * `unknown` during a throttle, so it is rethrown for the caller's retry path.
 */
function isRateLimited(error: unknown): boolean {
  const status = statusCode(error);
  if (status !== 403 && status !== 429) return false;

  const h = headers(error);
  if (String(h['x-ratelimit-remaining'] ?? '') === '0') return true;
  if (h['retry-after'] !== undefined) return true;

  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('rate limit') || message.includes('abuse');
}

/** A 403 demanding SAML SSO authorisation names it in this header. */
function isSsoRequired(error: unknown): boolean {
  return headers(error)['x-github-sso'] !== undefined;
}

/** Maps a failed request onto an unreachable reason, or null if it is transient. */
export function classifyError(error: unknown): UnreachableReason | null {
  const status = statusCode(error);
  if (status === 404) return 'not_found';
  if (status === 401) return 'unauthorized';
  if (status === 403) {
    if (isRateLimited(error) && !isSsoRequired(error)) return null;
    return 'forbidden';
  }
  return null;
}

export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: Octokit;

  constructor(options: { token: string; baseUrl?: string; userAgent?: string }) {
    this.octokit = new Octokit({
      auth: options.token,
      baseUrl: options.baseUrl ?? 'https://api.github.com',
      userAgent: options.userAgent ?? 'mm-slack-cb-pr-status',
    });
  }

  /**
   * Fetches and parses the codeowner bot's status comment on a PR.
   *
   * Scans all issue comments in reverse order (most recent first) for a comment
   * by `botLogin` that matches the codeowner status format. Returns null when
   * the bot hasn't commented yet or the PR has no codeowner requirements.
   * Access failures are swallowed — codeowner status is best-effort.
   */
  async fetchCodeownerStatus(ref: PrRef, botLogin: string): Promise<CodeownerStatus | null> {
    const { owner, repo, number } = ref;
    const login = botLogin.toLowerCase();

    try {
      const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: number,
        per_page: 100,
      });

      for (const comment of [...comments].reverse()) {
        if (comment.user?.login?.toLowerCase() !== login) continue;
        const parsed = parseCodeownerComment(comment.body ?? '');
        if (parsed !== null) return parsed;
      }

      return null;
    } catch (error) {
      if (classifyError(error)) return null;
      throw error;
    }
  }

  /**
   * One PR's current status: two requests (the PR itself, plus its reviews,
   * paginated). An access failure surfaces as PrUnreachableError; anything else
   * (5xx, rate limiting, network) is rethrown as transient.
   */
  async fetchPrStatus(ref: PrRef): Promise<PrStatus> {
    const { owner, repo, number } = ref;

    try {
      const { data: pr } = await this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: number,
      });

      const reviews = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      });

      return {
        merged: Boolean(pr.merged ?? pr.merged_at),
        closed: pr.state === 'closed',
        draft: Boolean(pr.draft),
        // `requested_reviewers` is what makes a re-requested review read as
        // pending again rather than blocking forever. See summariseReviews.
        ...summariseReviews(reviews, pr.requested_reviewers ?? []),
        title: pr.title ?? '',
      };
    } catch (error) {
      const reason = classifyError(error);
      if (reason) throw new PrUnreachableError(ref, reason, statusCode(error) ?? 0);
      throw error;
    }
  }
}
