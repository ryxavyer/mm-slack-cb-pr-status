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
      kind: 'set_teams',
      teams: ['creator-team'],
    });
  });

  it('accepts the mention format with a display name, extra spacing and any case', () => {
    expect(parseSetupCommand('  <@UBOT123|cb-pr-status>   TEAM   Creator-Team  ', BOT)).toEqual({
      kind: 'set_teams',
      teams: ['creator-team'],
    });
  });

  it('drops an org prefix and a leading @, as GitHub shows team names', () => {
    expect(parseSetupCommand('<@UBOT123> team @multimediallc/creator-team', BOT)).toEqual({
      kind: 'set_teams',
      teams: ['creator-team'],
    });
    expect(parseSetupCommand('<@UBOT123> team multimediallc/creator-team', BOT)).toEqual({
      kind: 'set_teams',
      teams: ['creator-team'],
    });
  });

  it('clears the team', () => {
    for (const word of ['none', 'off', 'clear', 'NONE']) {
      expect(parseSetupCommand(`<@UBOT123> team ${word}`, BOT)).toEqual({ kind: 'set_teams', teams: [] });
    }
  });

  it('reports anything else addressed to the bot as invalid', () => {
    expect(parseSetupCommand('<@UBOT123>', BOT)).toEqual({ kind: 'invalid' });
    expect(parseSetupCommand('<@UBOT123> hello', BOT)).toEqual({ kind: 'invalid' });
    expect(parseSetupCommand('<@UBOT123> team', BOT)).toEqual({ kind: 'invalid' });
    expect(parseSetupCommand('<@UBOT123> team creator-team!', BOT)).toEqual({ kind: 'invalid' });
  });

  it('sets several teams, separated by spaces, commas or both', () => {
    for (const list of [
      'monetization-team creator-team',
      'monetization-team, creator-team',
      'monetization-team,creator-team',
      '@multimediallc/monetization-team  @multimediallc/creator-team',
    ]) {
      expect(parseSetupCommand(`<@UBOT123> team ${list}`, BOT), list).toEqual({
        kind: 'set_teams',
        teams: ['monetization-team', 'creator-team'],
      });
    }
  });

  it('lists a team once however often it is named', () => {
    expect(parseSetupCommand('<@UBOT123> team creator-team Creator-Team', BOT)).toEqual({
      kind: 'set_teams',
      teams: ['creator-team'],
    });
  });

  it('rejects a clear word mixed with teams', () => {
    expect(parseSetupCommand('<@UBOT123> team none creator-team', BOT)).toEqual({ kind: 'invalid' });
  });
});
