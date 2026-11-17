/**
 * Conditional requests for GitHub GETs. GitHub tags each response with an ETag;
 * sending it back as If-None-Match gets a bodiless 304 when nothing changed,
 * and a 304 does not count against the hourly rate limit. Most tracked PRs are
 * unchanged in most poll cycles, so this is what lets the poll scale with PR
 * activity rather than with the number of open PRs.
 *
 * Installed as an Octokit request hook, so every GET (paginated pages included)
 * goes through it and callers never see a 304. Kept in memory only: a restart
 * costs one full cycle.
 */

/** Octokit's request options, as far as the cache touches them. */
export type RequestOptions = Record<string, unknown> & { headers?: Record<string, unknown> };

export interface CachedResponse {
  status: number;
  url: string;
  headers: Record<string, string | number | undefined>;
  data: unknown;
}

/** The next step in Octokit's request chain. */
export type RequestFn = (options: RequestOptions) => Promise<CachedResponse>;

/** The request's method and full URL, query included: what the cache is keyed on. */
export interface RequestTarget {
  method: string;
  url: string;
}

/** GET requests since the last call to takeStats, and how many came back unchanged. */
export interface RequestStats {
  requests: number;
  notModified: number;
}

interface Entry {
  etag: string;
  response: CachedResponse;
  storedAt: number;
}

/** GitHub's page size when a request doesn't set per_page. */
const DEFAULT_PER_PAGE = 30;

export class EtagCache {
  private readonly entries = new Map<string, Entry>();
  private stats: RequestStats = { requests: 0, notModified: 0 };
  private lastSweep: number;

  /**
   * @param maxAgeMs how long a stored response may be reused before it's
   *   fetched in full again. A safety net: a wrong cached answer can last at
   *   most this long. It also bounds memory, since entries for PRs no longer
   *   polled expire.
   */
  constructor(
    private readonly maxAgeMs = 30 * 60_000,
    private readonly now: () => number = Date.now,
  ) {
    this.lastSweep = now();
  }

  async request(request: RequestFn, options: RequestOptions, target: RequestTarget): Promise<CachedResponse> {
    const { method, url } = target;
    if (method.toUpperCase() !== 'GET') return request(options);

    this.stats.requests += 1;
    const now = this.now();
    this.sweep(now);

    const cached = this.entries.get(url);
    if (!cached || now - cached.storedAt >= this.maxAgeMs) {
      this.entries.delete(url);
      const response = await request(options);
      this.remember(url, response, now);
      return response;
    }

    try {
      // Octokit binds every request hook to this one options object and ignores
      // what's passed down, so the header must go on it rather than on a copy.
      options.headers = { ...options.headers, 'if-none-match': cached.etag };
      const response = await request(options);
      this.remember(url, response, now);
      return response;
    } catch (error) {
      if (statusOf(error) !== 304) throw error;
      this.stats.notModified += 1;
      // A copy, so a caller can't change what later polls get back.
      return structuredClone(cached.response);
    }
  }

  /** Returns the counts since the last call, and starts counting again. */
  takeStats(): RequestStats {
    const stats = this.stats;
    this.stats = { requests: 0, notModified: 0 };
    return stats;
  }

  get size(): number {
    return this.entries.size;
  }

  private remember(url: string, response: CachedResponse, now: number): void {
    const etag = response.headers['etag'];
    // A full page may have grown a next page since, which a 304 on this one
    // wouldn't reveal, so it's always fetched in full.
    if (typeof etag !== 'string' || isFullPage(url, response.data)) {
      this.entries.delete(url);
      return;
    }
    this.entries.set(url, { etag, response: structuredClone(response), storedAt: now });
  }

  /** Drops expired entries, at most once per max age. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.maxAgeMs) return;
    this.lastSweep = now;
    for (const [url, entry] of this.entries) {
      if (now - entry.storedAt >= this.maxAgeMs) this.entries.delete(url);
    }
  }
}

function isFullPage(url: string, data: unknown): boolean {
  if (!Array.isArray(data)) return false;
  const perPage = Number(new URL(url).searchParams.get('per_page') ?? DEFAULT_PER_PAGE);
  return data.length >= perPage;
}

function statusOf(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}
