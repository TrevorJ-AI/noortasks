import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from '../src/index.js';
import { expectValidSpans, makeOpts } from './helpers.js';

// Reference now: Sunday 2026-11-15T14:00:00.000Z

describe('times, time ranges, durations, and part-of-day words', () => {
  describe('explicit times', () => {
    it('parses 12-hour am time (forward to tomorrow when already past 14:00)', () => {
      const res = parseQuickAdd('Standup at 9am', makeOpts());
      expectValidSpans('Standup at 9am', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-16T09:00:00.000+00:00');
      expect(res.dueDate).toBeUndefined();
      expect(res.title).toBe('Standup');
      expect(res.recognized.some((r) => r.kind === 'time')).toBe(true);
    });

    it('parses 24-hour colon time', () => {
      const res = parseQuickAdd('Call Alex 14:30', makeOpts());
      expectValidSpans('Call Alex 14:30', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T14:30:00.000+00:00');
      expect(res.title).toBe('Call Alex');
    });

    it('parses 24-hour dot time H.mm', () => {
      const res = parseQuickAdd('Read book 21.30', makeOpts());
      expectValidSpans('Read book 21.30', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T21:30:00.000+00:00');
      expect(res.title).toBe('Read book');
    });

    it('parses dot time with leading preposition at 9.30', () => {
      const res = parseQuickAdd('Meeting at 9.30', makeOpts());
      expectValidSpans('Meeting at 9.30', res);
      expect(res.isAllDay).toBe(false);
      // Either 21:30 today or 09:30 tomorrow; ensure minutes are :30
      expect(res.startDate).toMatch(/:30:00\.000\+00:00$/);
      expect(res.title).toBe('Meeting');
    });

    it('parses 12-hour dot time with meridiem 9.30am', () => {
      const res = parseQuickAdd('Dentist 9.30am tomorrow', makeOpts());
      expectValidSpans('Dentist 9.30am tomorrow', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-16T09:30:00.000+00:00');
      expect(res.title).toBe('Dentist');
    });

    it('parses o clock expressions', () => {
      const res = parseQuickAdd("Tea 5 o'clock", makeOpts());
      expectValidSpans("Tea 5 o'clock", res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T17:00:00.000+00:00');
      expect(res.title).toBe('Tea');
    });

    it('disambiguates bare hour after now today (at 3 at 14:00 -> 15:00 today)', () => {
      const res = parseQuickAdd('Call at 3', makeOpts());
      expectValidSpans('Call at 3', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T15:00:00.000+00:00');
    });

    it('disambiguates bare hour 9 at 14:00 to 21:00 today', () => {
      const res = parseQuickAdd('Call at 9', makeOpts());
      expectValidSpans('Call at 9', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T21:00:00.000+00:00');
    });

    it('parses noon as 12:00', () => {
      const res = parseQuickAdd('Lunch tomorrow noon', makeOpts());
      expectValidSpans('Lunch tomorrow noon', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-16T12:00:00.000+00:00');
    });

    it('parses midnight as 00:00', () => {
      const res = parseQuickAdd('Deploy midnight tonight', makeOpts());
      expectValidSpans('Deploy midnight tonight', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toContain('T00:00:00.000');
    });

    it('parses bare meridiem word without digits? or numeric 6 p.m.', () => {
      const res = parseQuickAdd('Walk at 6 p.m.', makeOpts());
      expectValidSpans('Walk at 6 p.m.', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T18:00:00.000+00:00');
    });

    it('combines explicit future date with time', () => {
      const res = parseQuickAdd('Launch on 2026-12-01 at 10am', makeOpts());
      expectValidSpans('Launch on 2026-12-01 at 10am', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-12-01T10:00:00.000+00:00');
      expect(res.title).toBe('Launch');
    });

    it('formats wall-clock time accurately in America/New_York', () => {
      // 14:00 UTC is 09:00 EST (-05:00), so 3pm today is 2026-11-15T15:00:00.000-05:00
      const res = parseQuickAdd('Sync 3pm', makeOpts({ timeZone: 'America/New_York' }));
      expectValidSpans('Sync 3pm', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T15:00:00.000-05:00');
    });

    it('uses summer BST offset for summer dates in Europe/London', () => {
      const res = parseQuickAdd('Picnic 2026-07-10 at 5pm', makeOpts({ timeZone: 'Europe/London' }));
      expectValidSpans('Picnic 2026-07-10 at 5pm', res);
      expect(res.startDate).toBe('2026-07-10T17:00:00.000+01:00');
    });
  });

  describe('time ranges', () => {
    it('parses from 2pm to 4pm', () => {
      const res = parseQuickAdd('Workshop tomorrow from 2pm to 4pm', makeOpts());
      expectValidSpans('Workshop tomorrow from 2pm to 4pm', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-16T14:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-11-16T16:00:00.000+00:00');
      expect(res.title).toBe('Workshop');
    });

    it('parses hyphenated 9am-11am', () => {
      const res = parseQuickAdd('Focus block 9am-11am tomorrow', makeOpts());
      expectValidSpans('Focus block 9am-11am tomorrow', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-16T09:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-11-16T11:00:00.000+00:00');
      expect(res.title).toBe('Focus block');
    });

    it('parses 24-hour range 15:00-17:30', () => {
      const res = parseQuickAdd('Review 15:00-17:30', makeOpts());
      expectValidSpans('Review 15:00-17:30', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T15:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-11-15T17:30:00.000+00:00');
    });

    it('parses tilde time range 3pm ~ 5pm', () => {
      const res = parseQuickAdd('Study 3pm ~ 5pm', makeOpts());
      expectValidSpans('Study 3pm ~ 5pm', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T15:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-11-15T17:00:00.000+00:00');
      expect(res.title).toBe('Study');
    });

    it('parses until time range 4pm until 6pm', () => {
      const res = parseQuickAdd('Lab 4pm until 6pm', makeOpts());
      expectValidSpans('Lab 4pm until 6pm', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T16:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-11-15T18:00:00.000+00:00');
    });

    it('propagates PM meridiem backward to start hour in 2 - 4pm', () => {
      const res = parseQuickAdd('Design review tomorrow 2 - 4pm', makeOpts());
      expectValidSpans('Design review tomorrow 2 - 4pm', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-16T14:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-11-16T16:00:00.000+00:00');
    });

    it('rolls dueDate to next day when end time crosses midnight (10pm to 2am)', () => {
      const res = parseQuickAdd('Night watch from 10pm to 2am', makeOpts());
      expectValidSpans('Night watch from 10pm to 2am', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T22:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-11-16T02:00:00.000+00:00');
    });

    it('merges separate date and time range tokens across title words', () => {
      const res = parseQuickAdd('Friday team lunch 12pm-1:30pm', makeOpts());
      expectValidSpans('Friday team lunch 12pm-1:30pm', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-20T12:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-11-20T13:30:00.000+00:00');
      expect(res.title).toBe('team lunch');
    });
  });

  describe('durations', () => {
    it('adds 1 hour duration to explicit start time', () => {
      const res = parseQuickAdd('Call at 3pm for 1 hour', makeOpts());
      expectValidSpans('Call at 3pm for 1 hour', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T15:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-11-15T16:00:00.000+00:00');
      expect(res.title).toBe('Call');
    });

    it('adds 90 minutes duration to tomorrow 2pm', () => {
      const res = parseQuickAdd('Session tomorrow 2pm for 90 minutes', makeOpts());
      expectValidSpans('Session tomorrow 2pm for 90 minutes', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-16T14:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-11-16T15:30:00.000+00:00');
      expect(res.title).toBe('Session');
    });

    it('adds half an hour duration', () => {
      const res = parseQuickAdd('Coffee at 4pm for half an hour', makeOpts());
      expectValidSpans('Coffee at 4pm for half an hour', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T16:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-11-15T16:30:00.000+00:00');
      expect(res.title).toBe('Coffee');
    });

    it('parses compact compound duration 1h 30m', () => {
      const res = parseQuickAdd('Workout tomorrow 6pm for 1h 30m', makeOpts());
      expectValidSpans('Workout tomorrow 6pm for 1h 30m', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-16T18:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-11-16T19:30:00.000+00:00');
    });

    it('parses decimal hours 1.5 hours', () => {
      const res = parseQuickAdd('Rehearsal tomorrow 10am for 1.5 hours', makeOpts());
      expectValidSpans('Rehearsal tomorrow 10am for 1.5 hours', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-16T10:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-11-16T11:30:00.000+00:00');
    });

    it('parses multi-day all-day duration with exclusive end date (Nov 20 for 3 days)', () => {
      const res = parseQuickAdd('Conference Nov 20 for 3 days', makeOpts());
      expectValidSpans('Conference Nov 20 for 3 days', res);
      expect(res.isAllDay).toBe(true);
      expect(res.startDate).toBe('2026-11-20T00:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-11-23T00:00:00.000+00:00');
      expect(res.title).toBe('Conference');
    });

    it('parses multi-week all-day duration', () => {
      const res = parseQuickAdd('Trip Dec 1 for 2 weeks', makeOpts());
      expectValidSpans('Trip Dec 1 for 2 weeks', res);
      expect(res.isAllDay).toBe(true);
      expect(res.startDate).toBe('2026-12-01T00:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-12-15T00:00:00.000+00:00');
    });

    it('adds time duration onto now when no explicit start date/time is given', () => {
      const res = parseQuickAdd('Run for 45 minutes', makeOpts());
      expectValidSpans('Run for 45 minutes', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T14:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-11-15T14:45:00.000+00:00');
    });
  });

  describe('part-of-day and meal words', () => {
    it('maps morning to 09:00', () => {
      const res = parseQuickAdd('Write report tomorrow morning', makeOpts());
      expectValidSpans('Write report tomorrow morning', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-16T09:00:00.000+00:00');
      expect(res.title).toBe('Write report');
    });

    it('maps afternoon to 13:00', () => {
      const res = parseQuickAdd('Doctor tomorrow afternoon', makeOpts());
      expectValidSpans('Doctor tomorrow afternoon', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-16T13:00:00.000+00:00');
      expect(res.title).toBe('Doctor');
    });

    it('maps evening to 17:00', () => {
      const res = parseQuickAdd('Yoga Friday evening', makeOpts());
      expectValidSpans('Yoga Friday evening', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-20T17:00:00.000+00:00');
      expect(res.title).toBe('Yoga');
    });

    it('maps night and tonight to 20:00', () => {
      const res = parseQuickAdd('Read tonight', makeOpts());
      expectValidSpans('Read tonight', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T20:00:00.000+00:00');
      expect(res.title).toBe('Read');

      const res2 = parseQuickAdd('Movie tomorrow night', makeOpts());
      expect(res2.startDate).toBe('2026-11-16T20:00:00.000+00:00');
    });

    it('maps bare this afternoon to 13:00 (forward to tomorrow if 13:00 is past at 14:00)', () => {
      const res = parseQuickAdd('Walk this afternoon', makeOpts());
      expectValidSpans('Walk this afternoon', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toContain('T13:00:00.000+00:00');
    });

    it('parses prepositional meal anchors (at breakfast, at lunch, at dinner)', () => {
      const b = parseQuickAdd('Take vitamins tomorrow at breakfast', makeOpts());
      expectValidSpans('Take vitamins tomorrow at breakfast', b);
      expect(b.isAllDay).toBe(false);
      expect(b.startDate).toBe('2026-11-16T08:00:00.000+00:00');
      expect(b.title).toBe('Take vitamins');

      const l = parseQuickAdd('Meet Sarah tomorrow at lunch', makeOpts());
      expect(l.isAllDay).toBe(false);
      expect(l.startDate).toBe('2026-11-16T12:00:00.000+00:00');

      const d = parseQuickAdd('Call parents at dinner', makeOpts());
      expect(d.isAllDay).toBe(false);
      expect(d.startDate).toBe('2026-11-15T19:00:00.000+00:00');
    });
  });
});
