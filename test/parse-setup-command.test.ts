import { describe, expect, it } from 'vitest';
import { parseSetupCommand } from '../src/slack/parse-setup-command.js';

const BOT = 'UBOT123';

describe('parseSetupCommand', () => {
  it('ignores messages that do not start by mentioning the bot', () => {
    expect(parseSetupCommand('team creator-team', BOT)).toBeNull();
    expect(parseSetupCommand('thanks <@UBOT123> team creator-team', BOT)).toBeNull();
    expect(parseSetupCommand('<@UOTHER> team creator-team', BOT)).toBeNull();
    expect(parseSetupCommand('', BOT)).toBeNull();
  });

  it('sets a team', () => {
    expect(parseSetupCommand('<@UBOT123> team creator-team', BOT)).toEqual({
      kind: 'set_team',
      team: 'creator-team',
    });
  });

  it('accepts the mention format with a display name, extra spacing and any case', () => {
    expect(parseSetupCommand('  <@UBOT123|cb-pr-status>   TEAM   Creator-Team  ', BOT)).toEqual({
      kind: 'set_team',
      team: 'creator-team',
    });
  });

  it('drops an org prefix and a leading @, as GitHub shows team names', () => {
    expect(parseSetupCommand('<@UBOT123> team @multimediallc/creator-team', BOT)).toEqual({
      kind: 'set_team',
      team: 'creator-team',
    });
    expect(parseSetupCommand('<@UBOT123> team multimediallc/creator-team', BOT)).toEqual({
      kind: 'set_team',
      team: 'creator-team',
    });
  });

  it('clears the team', () => {
    for (const word of ['none', 'off', 'clear', 'NONE']) {
      expect(parseSetupCommand(`<@UBOT123> team ${word}`, BOT)).toEqual({ kind: 'set_team', team: null });
    }
  });

  it('reports anything else addressed to the bot as invalid', () => {
    expect(parseSetupCommand('<@UBOT123>', BOT)).toEqual({ kind: 'invalid' });
    expect(parseSetupCommand('<@UBOT123> hello', BOT)).toEqual({ kind: 'invalid' });
    expect(parseSetupCommand('<@UBOT123> team', BOT)).toEqual({ kind: 'invalid' });
    expect(parseSetupCommand('<@UBOT123> team creator-team monetization-team', BOT)).toEqual({
      kind: 'invalid',
    });
  });
});
