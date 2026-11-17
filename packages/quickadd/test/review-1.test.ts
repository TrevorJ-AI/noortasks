import { describe, expect, it } from 'vitest';
import { parseQuickAdd, type ParseQuickAddOptions } from '../src/index.js';
import { expectValidSpans } from './helpers.js';

// Reviewer harness reference: Sunday 2026-11-15T20:00:00Z = 21:00+01:00 Europe/Amsterdam, weekStart = 1 (Monday)
const AMS_NOW = new Date('2026-11-15T20:00:00.000Z');

function amsOpts(overrides: Partial<ParseQuickAddOptions> = {}): ParseQuickAddOptions {
  return {
    now: AMS_NOW,
    timeZone: 'Europe/Amsterdam',
    weekStart: 1,
    lists: ['Sprint 12', 'Work', 'Health'],
    tags: ['work', 'ui', 'finance', 'fitness'],
    assignees: ['Alice-Bob'],
    ...overrides,
  };
}

describe('review 1 item 1: weekday list repeat phrases', () => {
  it('parses "gym every mon wed fri at 7am" (space-separated days + time)', () => {
    const input = 'gym every mon wed fri at 7am';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('gym');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR');
    expect(res.isAllDay).toBe(false);
    expect(res.startDate).toBe('2026-11-16T07:00:00.000+01:00');
  });

  it('parses space-separated 3-letter days without time', () => {
    const input = 'standup every mon wed fri';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('standup');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR');
    expect(res.isAllDay).toBe(true);
    expect(res.startDate).toBe('2026-11-16T00:00:00.000+01:00');
  });

  it('parses space-separated full weekday names ("every monday wednesday friday")', () => {
    const input = 'standup every monday wednesday friday';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('standup');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR');
    expect(res.startDate).toBe('2026-11-16T00:00:00.000+01:00');
  });

  it('parses space-separated days with bare trailing time ("stretch every tue thu sat 8am")', () => {
    const input = 'stretch every tue thu sat 8am';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('stretch');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH,SA');
    expect(res.isAllDay).toBe(false);
    expect(res.startDate).toBe('2026-11-17T08:00:00.000+01:00');
  });

  it('parses comma-separated 2 days ("every tue, thu")', () => {
    const input = 'piano every tue, thu';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('piano');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH');
    expect(res.startDate).toBe('2026-11-17T00:00:00.000+01:00');
  });

  it('parses mixed comma + "and" ("every mon, wed and fri")', () => {
    const input = 'trash out every mon, wed and fri';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('trash out');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR');
    expect(res.startDate).toBe('2026-11-16T00:00:00.000+01:00');
  });

  it('parses Oxford comma + "and" ("every mon, wed, and fri")', () => {
    const input = 'trash out every mon, wed, and fri';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('trash out');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR');
    expect(res.startDate).toBe('2026-11-16T00:00:00.000+01:00');
  });

  it('parses Oxford comma + ampersand ("every mon, wed, & fri")', () => {
    const input = 'swim every mon, wed, & fri at 6pm';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('swim');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR');
    expect(res.startDate).toBe('2026-11-16T18:00:00.000+01:00');
  });

  it('parses slash-separated 2 days ("every tue/thu")', () => {
    const input = 'sync every tue/thu';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('sync');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH');
    expect(res.startDate).toBe('2026-11-17T00:00:00.000+01:00');
  });

  it('parses slash-separated 4 days ("every mon/tue/wed/thu")', () => {
    const input = 'focus every mon/tue/wed/thu at 9am';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('focus');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH');
    expect(res.startDate).toBe('2026-11-16T09:00:00.000+01:00');
  });

  it('parses ampersand-separated 2 days including today ("every sat & sun")', () => {
    const input = 'baking every sat & sun';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('baking');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SA,SU');
    expect(res.startDate).toBe('2026-11-15T00:00:00.000+01:00');
  });

  it('parses "and"-separated 3 days ("every wed and thu and fri")', () => {
    const input = 'check logs every wed and thu and fri';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('check logs');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=WE,TH,FR');
    expect(res.startDate).toBe('2026-11-18T00:00:00.000+01:00');
  });

  it('parses 5 space-separated days ("every mon tue wed thu fri")', () => {
    const input = 'commute every mon tue wed thu fri at 8:30am';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('commute');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR');
    expect(res.startDate).toBe('2026-11-16T08:30:00.000+01:00');
  });

  it('parses 6 slash/comma mixed days ("every mon, tue, wed/thu, fri & sat")', () => {
    const input = 'practice every mon, tue, wed/thu, fri & sat';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('practice');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR,SA');
    expect(res.startDate).toBe('2026-11-16T00:00:00.000+01:00');
  });

  it('parses all 7 days space-separated ("every mon tue wed thu fri sat sun")', () => {
    const input = 'water plants every mon tue wed thu fri sat sun';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('water plants');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR,SA,SU');
    expect(res.startDate).toBe('2026-11-15T00:00:00.000+01:00');
  });

  it('parses all 7 full day names comma-separated', () => {
    const input = 'journal every monday, tuesday, wednesday, thursday, friday, saturday, sunday at 9pm';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('journal');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR,SA,SU');
    expect(res.startDate).toBe('2026-11-15T21:00:00.000+01:00');
  });

  it('parses "every weekday" with and without time', () => {
    const a = parseQuickAdd('check email every weekday', amsOpts());
    expectValidSpans('check email every weekday', a);
    expect(a.title).toBe('check email');
    expect(a.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR');
    expect(a.startDate).toBe('2026-11-16T00:00:00.000+01:00');

    const b = parseQuickAdd('check email every weekday at 9am', amsOpts());
    expect(b.title).toBe('check email');
    expect(b.startDate).toBe('2026-11-16T09:00:00.000+01:00');
  });

  it('parses "every weekend" with and without time', () => {
    const a = parseQuickAdd('laundry every weekend', amsOpts());
    expectValidSpans('laundry every weekend', a);
    expect(a.title).toBe('laundry');
    expect(a.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SA,SU');
    expect(a.startDate).toBe('2026-11-15T00:00:00.000+01:00');

    const b = parseQuickAdd('laundry every weekend at 10am', amsOpts());
    expect(b.title).toBe('laundry');
    // Sunday Nov 15 10am already passed at 21:00 -> next weekend day is Saturday Nov 21
    expect(b.startDate).toBe('2026-11-21T10:00:00.000+01:00');
  });

  it('parses "every other" with weekday list ("every other mon wed fri")', () => {
    const input = 'swim every other mon wed fri at 7am';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('swim');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR');
    expect(res.startDate).toBe('2026-11-16T07:00:00.000+01:00');
  });

  it('parses "every other week on mon/wed" and "every other week tue thu"', () => {
    const a = parseQuickAdd('sync every other week on mon/wed', amsOpts());
    expectValidSpans('sync every other week on mon/wed', a);
    expect(a.title).toBe('sync');
    expect(a.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE');
    expect(a.startDate).toBe('2026-11-16T00:00:00.000+01:00');

    const b = parseQuickAdd('sync every other week tue thu at 3pm', amsOpts());
    expectValidSpans('sync every other week tue thu at 3pm', b);
    expect(b.title).toBe('sync');
    expect(b.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH');
    expect(b.startDate).toBe('2026-11-17T15:00:00.000+01:00');
  });

  it('parses "every 2 weeks" with mixed separators and without "on"', () => {
    const a = parseQuickAdd('payroll every 2 weeks on mon, wed & fri at 10am', amsOpts());
    expectValidSpans('payroll every 2 weeks on mon, wed & fri at 10am', a);
    expect(a.title).toBe('payroll');
    expect(a.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR');
    expect(a.startDate).toBe('2026-11-16T10:00:00.000+01:00');

    const b = parseQuickAdd('clean fridge every 2 weeks wed fri', amsOpts());
    expectValidSpans('clean fridge every 2 weeks wed fri', b);
    expect(b.title).toBe('clean fridge');
    expect(b.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,FR');
    expect(b.startDate).toBe('2026-11-18T00:00:00.000+01:00');
  });

  it('parses "weekly mon wed fri" and "biweekly mon/wed"', () => {
    const a = parseQuickAdd('standup weekly mon wed fri at 9am', amsOpts());
    expectValidSpans('standup weekly mon wed fri at 9am', a);
    expect(a.title).toBe('standup');
    expect(a.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR');
    expect(a.startDate).toBe('2026-11-16T09:00:00.000+01:00');

    const b = parseQuickAdd('retro biweekly mon/wed', amsOpts());
    expectValidSpans('retro biweekly mon/wed', b);
    expect(b.title).toBe('retro');
    expect(b.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE');
  });

  it('parses plural weekday lists ("on mondays and thursdays", "on tuesdays, thursdays, and saturdays")', () => {
    const a = parseQuickAdd('review on mondays and thursdays', amsOpts());
    expectValidSpans('review on mondays and thursdays', a);
    expect(a.title).toBe('review');
    expect(a.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TH');
    expect(a.startDate).toBe('2026-11-16T00:00:00.000+01:00');

    const b = parseQuickAdd('run on tuesdays, thursdays, and saturdays at 6pm', amsOpts());
    expectValidSpans('run on tuesdays, thursdays, and saturdays at 6pm', b);
    expect(b.title).toBe('run');
    expect(b.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH,SA');
    expect(b.startDate).toBe('2026-11-17T18:00:00.000+01:00');
  });

  it('selects today when today matches the listed days and time has not passed (23:00 > 21:00)', () => {
    const input = 'backup every sun & wed at 23:00';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('backup');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SU,WE');
    expect(res.startDate).toBe('2026-11-15T23:00:00.000+01:00');
  });

  it('advances past today to next listed weekday when today matches but time already passed (7am < 21:00)', () => {
    const input = 'gym every sun wed fri at 7am';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('gym');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SU,WE,FR');
    expect(res.startDate).toBe('2026-11-18T07:00:00.000+01:00');
  });

  it('anchors weekday list listed in reverse day order (fri before wed before mon -> still picks Mon Nov 16)', () => {
    const input = 'sprint check every fri, wed, mon at 11am';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('sprint check');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=FR,WE,MO');
    expect(res.startDate).toBe('2026-11-16T11:00:00.000+01:00');
  });

  it('anchors weekday list combined with a time range ("from 7am to 8am")', () => {
    const input = 'gym every mon, wed and fri from 7am to 8am';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('gym');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR');
    expect(res.startDate).toBe('2026-11-16T07:00:00.000+01:00');
    expect(res.dueDate).toBe('2026-11-16T08:00:00.000+01:00');
  });

  it('anchors weekday list correctly mid-week when Wed 08:00 > 7am -> picks Friday Nov 20', () => {
    const wedMorning = new Date('2026-11-18T07:00:00.000Z'); // 08:00+01:00 Amsterdam
    const input = 'gym every mon wed fri at 7am';
    const res = parseQuickAdd(input, amsOpts({ now: wedMorning }));
    expectValidSpans(input, res);
    expect(res.title).toBe('gym');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR');
    expect(res.startDate).toBe('2026-11-20T07:00:00.000+01:00');
  });
});

describe('review 1 item 2: bare month names with of/for/to or verb/title usage must not parse', () => {
  const nonDateBareMonths = [
    'read march of the penguins',
    'march to the store',
    'may need help with taxes',
    'in the march of time',
    'march for science and education',
    'may of great value',
    'watch the ides of march',
    'book flight for may to paris',
    'may the force be with you',
    'before may be too late',
    'during march for charity',
    'march in the parade',
  ];

  for (const phrase of nonDateBareMonths) {
    it(`does not misparse "${phrase}"`, () => {
      const res = parseQuickAdd(phrase, amsOpts());
      expect(res.startDate).toBeUndefined();
      expect(res.dueDate).toBeUndefined();
      expect(res.isAllDay).toBeUndefined();
      expect(res.recognized).toEqual([]);
      expect(res.title).toBe(phrase);
    });
  }
});

describe('everyday phrases hunt (40+ varied phrases under Amsterdam TZ, weekStart 1)', () => {
  it('parses "pay rent on the 1st of every month"', () => {
    const res = parseQuickAdd('pay rent on the 1st of every month', amsOpts());
    expectValidSpans('pay rent on the 1st of every month', res);
    expect(res.title).toBe('pay rent');
    expect(res.repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1');
    expect(res.startDate).toBe('2026-12-01T00:00:00.000+01:00');
  });

  it('ignores "call april about the augustiner bier"', () => {
    const res = parseQuickAdd('call april about the augustiner bier', amsOpts());
    expect(res.startDate).toBeUndefined();
    expect(res.recognized).toEqual([]);
    expect(res.title).toBe('call april about the augustiner bier');
  });

  it('ignores "april fools prank"', () => {
    const res = parseQuickAdd('april fools prank', amsOpts());
    expect(res.startDate).toBeUndefined();
    expect(res.title).toBe('april fools prank');
  });

  it('ignores "buy june bugs for fishing"', () => {
    const res = parseQuickAdd('buy june bugs for fishing', amsOpts());
    expect(res.startDate).toBeUndefined();
    expect(res.title).toBe('buy june bugs for fishing');
  });

  it('ignores "august rush movie"', () => {
    const res = parseQuickAdd('august rush movie', amsOpts());
    expect(res.startDate).toBeUndefined();
    expect(res.title).toBe('august rush movie');
  });

  it('ignores "jan the intern called"', () => {
    const res = parseQuickAdd('jan the intern called', amsOpts());
    expect(res.startDate).toBeUndefined();
    expect(res.title).toBe('jan the intern called');
  });

  it('parses "buy milk on sunday at 10am" (today 21:00 -> rolls to next Sunday Nov 22)', () => {
    const res = parseQuickAdd('buy milk on sunday at 10am', amsOpts());
    expectValidSpans('buy milk on sunday at 10am', res);
    expect(res.title).toBe('buy milk');
    expect(res.isAllDay).toBe(false);
    expect(res.startDate).toBe('2026-11-22T10:00:00.000+01:00');
  });

  it('parses "meet Bob tomorrow morning" in Europe/Amsterdam', () => {
    const res = parseQuickAdd('meet Bob tomorrow morning', amsOpts());
    expectValidSpans('meet Bob tomorrow morning', res);
    expect(res.title).toBe('meet Bob');
    expect(res.startDate).toBe('2026-11-16T09:00:00.000+01:00');
  });

  it('does not parse currency amount "pay invoice 20.25 usd at corner store"', () => {
    const res = parseQuickAdd('pay invoice 20.25 usd at corner store', amsOpts());
    expect(res.startDate).toBeUndefined();
    expect(res.recognized).toEqual([]);
    expect(res.title).toBe('pay invoice 20.25 usd at corner store');
  });

  it('does not parse section number "read chapter 14.30 in textbook"', () => {
    const res = parseQuickAdd('read chapter 14.30 in textbook', amsOpts());
    expect(res.startDate).toBeUndefined();
    expect(res.recognized).toEqual([]);
    expect(res.title).toBe('read chapter 14.30 in textbook');
  });

  it('does not parse ordinal floor/hardware "buy 2nd monitor for desk"', () => {
    const res = parseQuickAdd('buy 2nd monitor for desk', amsOpts());
    expect(res.startDate).toBeUndefined();
    expect(res.title).toBe('buy 2nd monitor for desk');
  });

  it('parses "pick up dry cleaning before 6pm" preserving deadline cue "before"', () => {
    const res = parseQuickAdd('pick up dry cleaning before 6pm', amsOpts());
    expectValidSpans('pick up dry cleaning before 6pm', res);
    expect(res.isAllDay).toBe(false);
    expect(res.startDate).toBe('2026-11-16T18:00:00.000+01:00');
    expect(res.title).toBe('pick up dry cleaning before');
  });

  it('parses "submit expenses by friday #finance !2"', () => {
    const res = parseQuickAdd('submit expenses by friday #finance !2', amsOpts());
    expectValidSpans('submit expenses by friday #finance !2', res);
    expect(res.isAllDay).toBe(true);
    expect(res.startDate).toBe('2026-11-20T00:00:00.000+01:00');
    expect(res.tags).toEqual(['finance']);
    expect(res.priority).toBe(3);
    expect(res.title).toBe('submit expenses by');
  });

  it('strips "remind me to" cleanly in "remind me to call mom tomorrow"', () => {
    const res = parseQuickAdd('remind me to call mom tomorrow', amsOpts());
    expectValidSpans('remind me to call mom tomorrow', res);
    expect(res.title).toBe('call mom');
    expect(res.startDate).toBe('2026-11-16T00:00:00.000+01:00');
    expect(res.reminders).toEqual(['TRIGGER:P0DT9H0M0S']);
  });

  it('ignores "in the sun all afternoon"', () => {
    const res = parseQuickAdd('in the sun all afternoon', amsOpts());
    expect(res.startDate).toBeUndefined();
    expect(res.recognized).toEqual([]);
    expect(res.title).toBe('in the sun all afternoon');
  });

  it('ignores "friday the 13th movie night"', () => {
    const res = parseQuickAdd('friday the 13th movie night', amsOpts());
    expect(res.startDate).toBeUndefined();
    expect(res.recognized).toEqual([]);
    expect(res.title).toBe('friday the 13th movie night');
  });

  it('ignores "in the park all day"', () => {
    const res = parseQuickAdd('in the park all day', amsOpts());
    expect(res.startDate).toBeUndefined();
    expect(res.title).toBe('in the park all day');
  });

  it('parses "clean garage next weekend" with weekStart=1 -> Saturday Nov 21', () => {
    const res = parseQuickAdd('clean garage next weekend', amsOpts());
    expectValidSpans('clean garage next weekend', res);
    expect(res.title).toBe('clean garage');
    expect(res.startDate).toBe('2026-11-21T00:00:00.000+01:00');
    expect(res.isAllDay).toBe(true);
  });

  it('parses "team retro every 2nd fri of the month at 4pm"', () => {
    const res = parseQuickAdd('team retro every 2nd fri of the month at 4pm', amsOpts());
    expectValidSpans('team retro every 2nd fri of the month at 4pm', res);
    expect(res.title).toBe('team retro');
    expect(res.repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=2FR');
    expect(res.startDate).toBe('2026-12-11T16:00:00.000+01:00');
  });

  it('parses "pay tuition jan 15, 2027"', () => {
    const res = parseQuickAdd('pay tuition jan 15, 2027', amsOpts());
    expectValidSpans('pay tuition jan 15, 2027', res);
    expect(res.title).toBe('pay tuition');
    expect(res.startDate).toBe('2027-01-15T00:00:00.000+01:00');
    expect(res.isAllDay).toBe(true);
  });

  it('parses "dentist 11/20 at 14:30"', () => {
    const res = parseQuickAdd('dentist 11/20 at 14:30', amsOpts());
    expectValidSpans('dentist 11/20 at 14:30', res);
    expect(res.title).toBe('dentist');
    expect(res.startDate).toBe('2026-11-20T14:30:00.000+01:00');
    expect(res.isAllDay).toBe(false);
  });

  it('parses "flight at 6:30am-9:15am tomorrow"', () => {
    const res = parseQuickAdd('flight at 6:30am-9:15am tomorrow', amsOpts());
    expectValidSpans('flight at 6:30am-9:15am tomorrow', res);
    expect(res.title).toBe('flight');
    expect(res.startDate).toBe('2026-11-16T06:30:00.000+01:00');
    expect(res.dueDate).toBe('2026-11-16T09:15:00.000+01:00');
  });

  it('parses morning time range "deep work 10-11:30am" without flipping 10 to 22:00', () => {
    const res = parseQuickAdd('deep work 10-11:30am', amsOpts());
    expectValidSpans('deep work 10-11:30am', res);
    expect(res.title).toBe('deep work');
    expect(res.startDate).toBe('2026-11-16T10:00:00.000+01:00');
    expect(res.dueDate).toBe('2026-11-16T11:30:00.000+01:00');
  });

  it('parses "call 1-2pm tomorrow"', () => {
    const res = parseQuickAdd('call 1-2pm tomorrow', amsOpts());
    expectValidSpans('call 1-2pm tomorrow', res);
    expect(res.title).toBe('call');
    expect(res.startDate).toBe('2026-11-16T13:00:00.000+01:00');
    expect(res.dueDate).toBe('2026-11-16T14:00:00.000+01:00');
  });

  it('parses "meeting from 9 to 11 tomorrow" as 09:00-11:00 instead of 21:00-11:00', () => {
    const res = parseQuickAdd('meeting from 9 to 11 tomorrow', amsOpts());
    expectValidSpans('meeting from 9 to 11 tomorrow', res);
    expect(res.title).toBe('meeting');
    expect(res.startDate).toBe('2026-11-16T09:00:00.000+01:00');
    expect(res.dueDate).toBe('2026-11-16T11:00:00.000+01:00');
  });

  it('handles multi-word list, hyphenated assignee, and slash tag in "fix bug #ui/ux ~Sprint 12 !high @Alice-Bob"', () => {
    const input = 'fix bug #ui/ux ~Sprint 12 !high @Alice-Bob';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.tags).toEqual(['ui']);
    expect(res.list).toBe('Sprint 12');
    expect(res.priority).toBe(5);
    expect(res.assignee).toBe('Alice-Bob');
    expect(res.title).toBe('fix bug /ux');
  });

  it('absorbs possessive apostrophe-s and ignores email in "email bob@example.com about tomorrow\'s release"', () => {
    const input = "email bob@example.com about tomorrow's release";
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.assignee).toBeUndefined();
    expect(res.startDate).toBe('2026-11-16T00:00:00.000+01:00');
    expect(res.title).toBe('email bob@example.com about release');
  });

  it('leaves URL completely untouched in "check https://cal.example.com/2026-12-01/mon#work!1@tom"', () => {
    const input = 'check https://cal.example.com/2026-12-01/mon#work!1@tom';
    const res = parseQuickAdd(input, amsOpts());
    expect(res.startDate).toBeUndefined();
    expect(res.tags).toEqual([]);
    expect(res.priority).toBeUndefined();
    expect(res.assignee).toBeUndefined();
    expect(res.recognized).toEqual([]);
    expect(res.title).toBe(input);
  });

  it('parses "dinner with Tom and Sue tonight at 7" as 19:00 (not 07:00) and keeps Tom', () => {
    const input = 'dinner with Tom and Sue tonight at 7';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('dinner with Tom and Sue');
    expect(res.isAllDay).toBe(false);
    expect(res.startDate).toBe('2026-11-15T19:00:00.000+01:00');
  });

  it('parses leading repeat+time "every workday at 8:30am check slack"', () => {
    const input = 'every workday at 8:30am check slack';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('check slack');
    expect(res.repeatFlag).toBe('RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=HOLIDAY,WEEKEND');
    expect(res.startDate).toBe('2026-11-16T08:30:00.000+01:00');
  });

  it('parses leading ISO date "2026-11-16 prepare slides"', () => {
    const input = '2026-11-16 prepare slides';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('prepare slides');
    expect(res.startDate).toBe('2026-11-16T00:00:00.000+01:00');
  });

  it('parses "renew passport every 10 years on March 1"', () => {
    const input = 'renew passport every 10 years on March 1';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('renew passport');
    expect(res.repeatFlag).toBe('RRULE:FREQ=YEARLY;INTERVAL=10;BYMONTH=3;BYMONTHDAY=1');
    expect(res.startDate).toBe('2027-03-01T00:00:00.000+01:00');
  });

  it('parses "book club 1st thursday of every month at 7pm"', () => {
    const input = 'book club 1st thursday of every month at 7pm';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('book club');
    expect(res.repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=1TH');
    expect(res.startDate).toBe('2026-12-03T19:00:00.000+01:00');
  });

  it('parses "run 5k tomorrow 7am #fitness !medium ~Health"', () => {
    const input = 'run 5k tomorrow 7am #fitness !medium ~Health';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('run 5k');
    expect(res.startDate).toBe('2026-11-16T07:00:00.000+01:00');
    expect(res.priority).toBe(3);
    expect(res.tags).toEqual(['fitness']);
    expect(res.list).toBe('Health');
  });

  it('parses "meditate daily at 6.45am"', () => {
    const input = 'meditate daily at 6.45am';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('meditate');
    expect(res.repeatFlag).toBe('RRULE:FREQ=DAILY;INTERVAL=1');
    expect(res.startDate).toBe('2026-11-16T06:45:00.000+01:00');
  });

  it('parses "gym every mon wed fri starting Dec 1 at 7am"', () => {
    const input = 'gym every mon wed fri starting Dec 1 at 7am';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('gym');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR');
    expect(res.startDate).toBe('2026-12-01T07:00:00.000+01:00');
  });

  it('does not misparse "march of last year" as March while recognizing "last year"', () => {
    const input = 'in march of last year we met';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.startDate).toBe('2025-11-15T00:00:00.000+01:00');
    expect(res.title).toBe('in march of we met');
  });

  it('parses "call mom 15m before tomorrow at 6pm"', () => {
    const input = 'call mom 15m before tomorrow at 6pm';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('call mom');
    expect(res.startDate).toBe('2026-11-16T18:00:00.000+01:00');
    expect(res.reminders).toEqual(['TRIGGER:-PT15M']);
  });

  it('parses "water plants in 2 days" cleanly in Amsterdam timezone', () => {
    const input = 'water plants in 2 days';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('water plants');
    expect(res.startDate).toBe('2026-11-17T00:00:00.000+01:00');
    expect(res.isAllDay).toBe(true);
  });

  it('parses "tea at 3" at 21:00 -> rolls forward to 03:00 tomorrow', () => {
    const input = 'tea at 3';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('tea');
    expect(res.isAllDay).toBe(false);
    expect(res.startDate).toBe('2026-11-16T03:00:00.000+01:00');
  });

  it('parses "call at 10 tomorrow" at 21:00 as 10:00 AM tomorrow (not 22:00)', () => {
    const input = 'call at 10 tomorrow';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('call');
    expect(res.isAllDay).toBe(false);
    expect(res.startDate).toBe('2026-11-16T10:00:00.000+01:00');
  });

  it('parses "every mon tue fri until dec 20" with end date', () => {
    const input = 'sprint every mon tue fri until dec 20';
    const res = parseQuickAdd(input, amsOpts());
    expectValidSpans(input, res);
    expect(res.title).toBe('sprint');
    expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,FR;UNTIL=20261220');
    expect(res.startDate).toBe('2026-11-16T00:00:00.000+01:00');
  });
});
