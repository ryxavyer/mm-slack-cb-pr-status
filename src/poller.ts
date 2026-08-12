import type { Logger } from './logger.js';
import type { PrService } from './pr-service.js';

/**
 * In-process scheduler for the poll loop. No cron infrastructure: a single
 * `setInterval` with an overlap guard, plus a `stop()` that waits for the
 * in-flight cycle so SIGTERM never leaves a half-applied reaction state.
 */
export class Poller {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly service: PrService,
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  /** Starts the loop and kicks off an immediate first cycle. */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.logger.info({ intervalMs: this.intervalMs }, 'poll loop started');

    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Don't hold the event loop open on our own account.
    this.timer.unref?.();
    void this.tick();
  }

  /** Runs a cycle now, unless one is already running. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      this.logger.warn('previous poll cycle still running; skipping this tick');
      return;
    }

    this.inFlight = this.runCycle();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async runCycle(): Promise<void> {
    const startedAt = Date.now();
    try {
      const summary = await this.service.runCycle();
      this.logger.info({ ...summary, durationMs: Date.now() - startedAt }, 'poll cycle complete');
    } catch (error) {
      // Should be unreachable — runCycle catches per-PR — but a thrown cycle must
      // never kill the interval.
      this.logger.error({ err: error }, 'poll cycle failed');
    }
  }

  /** Stops scheduling and awaits the cycle currently in flight, if any. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight) {
      this.logger.info('waiting for in-flight poll cycle to finish');
      await this.inFlight.catch(() => undefined);
    }
    this.logger.info('poll loop stopped');
  }
}
