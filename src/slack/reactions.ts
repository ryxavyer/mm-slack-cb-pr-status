import type { WebClient } from '@slack/web-api';

/** The slice of the Slack Web API the reconciler needs — trivial to fake in tests. */
export interface ReactionClient {
  add(input: { channel: string; timestamp: string; name: string }): Promise<void>;
  remove(input: { channel: string; timestamp: string; name: string }): Promise<void>;
}

export class WebApiReactionClient implements ReactionClient {
  constructor(private readonly client: WebClient) {}

  async add(input: { channel: string; timestamp: string; name: string }): Promise<void> {
    await this.client.reactions.add(input);
  }

  async remove(input: { channel: string; timestamp: string; name: string }): Promise<void> {
    await this.client.reactions.remove(input);
  }
}

/**
 * Slack's error code for a failed Web API call, e.g. 'already_reacted'.
 * Bolt surfaces these as `err.data.error`; some paths only set `err.message`.
 */
export function slackErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;

  const data = (error as { data?: { error?: unknown } }).data;
  if (data && typeof data.error === 'string') return data.error;

  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string' && direct.includes('_')) return direct;

  return undefined;
}
