import { beforeEach, describe, expect, it } from 'vitest';
import { EtagCache, type CachedResponse, type RequestFn, type RequestOptions } from '../src/github/etag-cache.js';

type Method = 'GET' | 'POST';

const MAX_AGE = 30 * 60_000;
const URL_A = 'https://api.github.com/repos/acme/monolith/pulls/1';
const URL_B = 'https://api.github.com/repos/acme/monolith/pulls/2';

/**
 * A request function standing in for Octokit's: answers `url` with `data`
 * tagged `etag`, or throws a 304 when the caller already holds that tag.
 */
function fakeRequest() {
  const served = new Map<string, { etag: string | undefined; data: unknown }>();
  const sent: RequestOptions[] = [];

  const request: RequestFn = async (options: RequestOptions): Promise<CachedResponse> => {
    sent.push(options);
    const url = options['url'] as string;
    const { etag, data } = served.get(url)!;
    if (etag && options.headers?.['if-none-match'] === etag) {
      throw Object.assign(new Error('Not modified'), { status: 304 });
    }
    return { status: 200, url, headers: etag ? { etag } : {}, data };
  };

  return { served, sent, request };
}

describe('EtagCache', () => {
  let clock: number;
  let cache: EtagCache;
  let github: ReturnType<typeof fakeRequest>;

  const send = (url: string, method: Method = 'GET', request = github.request) =>
    cache.request(request, { method, url }, { method, url });
  const get = (url: string) => send(url);
  const lastIfNoneMatch = () => github.sent.at(-1)?.headers?.['if-none-match'];

  beforeEach(() => {
    clock = 1_000_000;
    cache = new EtagCache(MAX_AGE, () => clock);
    github = fakeRequest();
    github.served.set(URL_A, { etag: '"a1"', data: { title: 'A' } });
    github.served.set(URL_B, { etag: '"b1"', data: { title: 'B' } });
  });

  it('answers an unchanged resource from the cache', async () => {
    await get(URL_A);
    expect(lastIfNoneMatch()).toBeUndefined();

    const again = await get(URL_A);
    expect(lastIfNoneMatch()).toBe('"a1"');
    expect(again.data).toEqual({ title: 'A' });
    expect(cache.takeStats()).toEqual({ requests: 2, notModified: 1 });
  });

  it('replaces the stored answer when the resource changes', async () => {
    await get(URL_A);
    github.served.set(URL_A, { etag: '"a2"', data: { title: 'A, renamed' } });

    expect((await get(URL_A)).data).toEqual({ title: 'A, renamed' });
    await get(URL_A);
    expect(lastIfNoneMatch()).toBe('"a2"');
  });

  it('fetches in full once a stored answer reaches the max age', async () => {
    // Steps chosen so the periodic sweep runs in between and isn't what expires it.
    clock += MAX_AGE / 2;
    await get(URL_A);
    clock += MAX_AGE / 2;
    await get(URL_B);
    clock += MAX_AGE / 2 - 1;
    await get(URL_A);
    expect(lastIfNoneMatch()).toBe('"a1"');

    clock += 1;
    await get(URL_A);
    expect(lastIfNoneMatch()).toBeUndefined();
  });

  it('forgets resources nobody asks for any more', async () => {
    await get(URL_A);
    await get(URL_B);
    expect(cache.size).toBe(2);

    clock += MAX_AGE;
    github.served.set(URL_A, { etag: '"a1"', data: { title: 'A' } });
    await get(URL_A);
    expect(cache.size).toBe(1);
  });

  it('does not store a response without an ETag', async () => {
    github.served.set(URL_A, { etag: undefined, data: { title: 'A' } });
    await get(URL_A);
    await get(URL_A);
    expect(lastIfNoneMatch()).toBeUndefined();
  });

  it('does not store a full page, which may have grown a next one', async () => {
    const full = `${URL_A}/reviews?per_page=2`;
    const partial = `${URL_A}/reviews?per_page=3`;
    github.served.set(full, { etag: '"r"', data: [1, 2] });
    github.served.set(partial, { etag: '"r"', data: [1, 2] });

    await get(full);
    await get(full);
    expect(lastIfNoneMatch()).toBeUndefined();

    await get(partial);
    await get(partial);
    expect(lastIfNoneMatch()).toBe('"r"');
  });

  it('hands out copies, so a caller cannot change later answers', async () => {
    const first = await get(URL_A);
    (first.data as { title: string }).title = 'scribbled';
    const second = await get(URL_A);
    (second.data as { title: string }).title = 'scribbled again';

    expect((await get(URL_A)).data).toEqual({ title: 'A' });
  });

  it('passes errors other than 304 through', async () => {
    await get(URL_A);
    const failure = Object.assign(new Error('Bad gateway'), { status: 502 });
    const failing: RequestFn = () => Promise.reject(failure);

    await expect(send(URL_A, 'GET', failing)).rejects.toBe(failure);
  });

  it('leaves anything but GET alone', async () => {
    await send(URL_A, 'POST');
    await send(URL_A, 'POST');
    expect(lastIfNoneMatch()).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.takeStats()).toEqual({ requests: 0, notModified: 0 });
  });
});
