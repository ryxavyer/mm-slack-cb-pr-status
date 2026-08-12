import { describe, expect, it, vi } from 'vitest';
import { Poller } from '../src/poller.js';
import type { PrService } from '../src/pr-service.js';
import { testLogger } from './helpers.js';

/** A PrService stand-in whose cycle resolves only when the test says so. */
function controllableService() {
  // Armed by block(), consumed by the next cycle, fired by finish(). One-shot,
  // so cycles after the gated one run straight through.
  let armed = false;
  let release: (() => void) | undefined;

  const service = {
    runCycle: vi.fn(async () => {
      if (armed) {
        armed = false;
        await new Promise<void>((resolve) => (release = resolve));
        release = undefined;
      }
      return { polled: 0, changed: 0, failed: 0, cleaned: 0 };
    }),
  } as unknown as PrService;

  return {
    service,
    /** Makes the next cycle block until `finish()` is called. */
    block: () => {
      armed = true;
    },
    finish: () => release?.(),
  };
}

describe('Poller', () => {
  it('runs a cycle immediately on start', async () => {
    const { service } = controllableService();
    const poller = new Poller(service, 60_000, testLogger);

    poller.start();
    await poller.stop();

    expect(service.runCycle).toHaveBeenCalledTimes(1);
  });

  it('skips a tick while the previous cycle is still running', async () => {
    const { service, block, finish } = controllableService();
    const poller = new Poller(service, 60_000, testLogger);

    block();
    const first = poller.tick();
    await poller.tick(); // overlapping tick — must be dropped, not queued
    expect(service.runCycle).toHaveBeenCalledTimes(1);

    finish();
    await first;

    await poller.tick();
    expect(service.runCycle).toHaveBeenCalledTimes(2);
  });

  it('waits for the in-flight cycle before reporting stopped', async () => {
    const { service, block, finish } = controllableService();
    const poller = new Poller(service, 60_000, testLogger);

    block();
    const cycle = poller.tick();

    let stopped = false;
    const stopping = poller.stop().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false); // still draining

    finish();
    await cycle;
    await stopping;
    expect(stopped).toBe(true);
  });

  it('does not start new cycles after stopping', async () => {
    const { service } = controllableService();
    const poller = new Poller(service, 60_000, testLogger);

    poller.start();
    await poller.stop();
    await poller.tick();

    expect(service.runCycle).toHaveBeenCalledTimes(1);
  });

  it('keeps the loop alive when a cycle throws', async () => {
    const service = {
      runCycle: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({
        polled: 0,
        changed: 0,
        failed: 0,
        cleaned: 0,
      }),
    } as unknown as PrService;
    const poller = new Poller(service, 60_000, testLogger);

    await poller.tick();
    await poller.tick();

    expect(service.runCycle).toHaveBeenCalledTimes(2);
  });

  it('polls again once the interval elapses', async () => {
    vi.useFakeTimers();
    try {
      const { service } = controllableService();
      const poller = new Poller(service, 90_000, testLogger);

      poller.start();
      await vi.advanceTimersByTimeAsync(90_000);
      await vi.advanceTimersByTimeAsync(90_000);

      expect(service.runCycle).toHaveBeenCalledTimes(3); // start + two intervals
      await poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
