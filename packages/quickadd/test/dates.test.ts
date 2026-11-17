import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from '../src/index.js';
import { expectValidSpans, FIXED_NOW_UTC, makeOpts } from './helpers.js';

describe('absolute dates', () => {
  it('parses ISO YYYY-MM-DD dates', () => {
    const res = parseQuickAdd('Submit taxes 2026-12-25', makeOpts());
    expect(res.title).toBe('Submit taxes');
    expect(res.startDate).toBe('2026-12-25T00:00:00.000+00:00');
    expect(res.isAllDay).toBe(true);
    expect(res.dueDate).toBeUndefined();
    expectValidSpans('Submit taxes 2026-12-25', res);
  });

  it('parses YYYY-M-D with single-digit month and day', () => {
    const res = parseQuickAdd('Dentist 2027-3-4', makeOpts());
    expect(res.title).toBe('Dentist');
    expect(res.startDate).toBe('2027-03-04T00:00:00.000+00:00');
    expect(res.isAllDay).toBe(true);
  });

  it('parses slash YYYY/M/D dates', () => {
    const res = parseQuickAdd('Audit 2027/1/9', makeOpts());
    expect(res.title).toBe('Audit');
    expect(res.startDate).toBe('2027-01-09T00:00:00.000+00:00');
    expect(res.isAllDay).toBe(true);
  });

  it('parses US MM/DD slash dates forward into next year when already passed', () => {
    const res = parseQuickAdd('Renewal 3/4', makeOpts());
    expect(res.title).toBe('Renewal');
    expect(res.startDate).toBe('2027-03-04T00:00:00.000+00:00');
    expect(res.isAllDay).toBe(true);
  });

  it('parses MM/DD/YYYY slash dates', () => {
    const res = parseQuickAdd('Launch 12/20/2026', makeOpts());
    expect(res.title).toBe('Launch');
    expect(res.startDate).toBe('2026-12-20T00:00:00.000+00:00');
    expect(res.isAllDay).toBe(true);
  });

  it('falls back to DD/MM/YYYY when first number exceeds 12', () => {
    const res = parseQuickAdd('Holiday 25/12/2026', makeOpts());
    expect(res.title).toBe('Holiday');
    expect(res.startDate).toBe('2026-12-25T00:00:00.000+00:00');
  });

  it('parses dotted dates like 4.3.2027', () => {
    const res = parseQuickAdd('Flight 4.3.2027', makeOpts());
    expect(res.title).toBe('Flight');
    expect(res.startDate).toBe('2027-04-03T00:00:00.000+00:00');
  });

  it('parses full month name with ordinal day', () => {
    const res = parseQuickAdd('Review October 1st', makeOpts());
    expect(res.title).toBe('Review');
    expect(res.startDate).toBe('2027-10-01T00:00:00.000+00:00');
    expect(res.isAllDay).toBe(true);
  });

  it('parses abbreviated month name with day', () => {
    const res = parseQuickAdd('Party Nov 28', makeOpts());
    expect(res.title).toBe('Party');
    expect(res.startDate).toBe('2026-11-28T00:00:00.000+00:00');
  });

  it('parses little-endian day before month name', () => {
    const res = parseQuickAdd('Demo 15 Dec 2026', makeOpts());
    expect(res.title).toBe('Demo');
    expect(res.startDate).toBe('2026-12-15T00:00:00.000+00:00');
  });

  it('parses "1st of May"', () => {
    const res = parseQuickAdd('Festival 1st of May', makeOpts());
    expect(res.title).toBe('Festival');
    expect(res.startDate).toBe('2027-05-01T00:00:00.000+00:00');
  });

  it('parses "May 2027" with explicit year', () => {
    const res = parseQuickAdd('Conference May 2027', makeOpts());
    expect(res.title).toBe('Conference');
    expect(res.startDate?.startsWith('2027-05-')).toBe(true);
    expect(res.isAllDay).toBe(true);
  });

  it('parses month preceded by "in" like "in March"', () => {
    const res = parseQuickAdd('Travel in March', makeOpts());
    expect(res.title).toBe('Travel');
    expect(res.startDate).toBe('2027-03-01T00:00:00.000+00:00');
  });

  it('parses "end of month" and "last day of the month"', () => {
    const res1 = parseQuickAdd('Close books end of month', makeOpts());
    expect(res1.title).toBe('Close books');
    expect(res1.startDate).toBe('2026-11-30T00:00:00.000+00:00');

    const res2 = parseQuickAdd('Invoice last day of the month', makeOpts());
    expect(res2.title).toBe('Invoice');
    expect(res2.startDate).toBe('2026-11-30T00:00:00.000+00:00');
  });

  it('parses "beginning of next month" and "end of year"', () => {
    const res1 = parseQuickAdd('Kickoff beginning of next month', makeOpts());
    expect(res1.title).toBe('Kickoff');
    expect(res1.startDate).toBe('2026-12-01T00:00:00.000+00:00');

    const res2 = parseQuickAdd('Tax prep end of year', makeOpts());
    expect(res2.title).toBe('Tax prep');
    expect(res2.startDate).toBe('2026-12-31T00:00:00.000+00:00');
  });

  it('parses "on the 20th" and advances past day to next month', () => {
    const res1 = parseQuickAdd('Pay bill on the 20th', makeOpts());
    expect(res1.title).toBe('Pay bill');
    expect(res1.startDate).toBe('2026-11-20T00:00:00.000+00:00');

    const res2 = parseQuickAdd('Pay rent on the 1st', makeOpts());
    expect(res2.title).toBe('Pay rent');
    expect(res2.startDate).toBe('2026-12-01T00:00:00.000+00:00');
  });

  it('parses multi-day all-day date ranges with exclusive +1 day dueDate', () => {
    const res = parseQuickAdd('Vacation from Nov 20 to Nov 22', makeOpts());
    expect(res.title).toBe('Vacation');
    expect(res.isAllDay).toBe(true);
    expect(res.startDate).toBe('2026-11-20T00:00:00.000+00:00');
    expect(res.dueDate).toBe('2026-11-23T00:00:00.000+00:00');
  });

  it('parses hyphenated multi-day date ranges', () => {
    const res = parseQuickAdd('Summit Dec 1 - Dec 3', makeOpts());
    expect(res.title).toBe('Summit');
    expect(res.isAllDay).toBe(true);
    expect(res.startDate).toBe('2026-12-01T00:00:00.000+00:00');
    expect(res.dueDate).toBe('2026-12-04T00:00:00.000+00:00');
  });

  it('parses leap day 2028-02-29', () => {
    const res = parseQuickAdd('Special event 2028-02-29', makeOpts());
    expect(res.startDate).toBe('2028-02-29T00:00:00.000+00:00');
  });
});

describe('relative dates', () => {
  it('parses "today" and "tod"', () => {
    const res1 = parseQuickAdd('Clean desk today', makeOpts());
    expect(res1.title).toBe('Clean desk');
    expect(res1.startDate).toBe('2026-11-15T00:00:00.000+00:00');
    expect(res1.isAllDay).toBe(true);

    const res2 = parseQuickAdd('Clean desk tod', makeOpts());
    expect(res2.title).toBe('Clean desk');
    expect(res2.startDate).toBe('2026-11-15T00:00:00.000+00:00');
  });

  it('parses "tomorrow", "tom", "tmr", "tmrw"', () => {
    for (const kw of ['tomorrow', 'tom', 'tmr', 'tmrw']) {
      const res = parseQuickAdd(`Buy milk ${kw}`, makeOpts());
      expect(res.title).toBe('Buy milk');
      expect(res.startDate).toBe('2026-11-16T00:00:00.000+00:00');
      expect(res.isAllDay).toBe(true);
    }
  });

  it('does not confuse capitalized "Tom" after person verbs with tomorrow', () => {
    const res = parseQuickAdd('Call Tom at 3pm', makeOpts());
    expect(res.title).toBe('Call Tom');
    expect(res.startDate).toBe('2026-11-15T15:00:00.000+00:00');
  });

  it('parses "day after tomorrow" and "the day after tomorrow"', () => {
    const res1 = parseQuickAdd('Ship build day after tomorrow', makeOpts());
    expect(res1.title).toBe('Ship build');
    expect(res1.startDate).toBe('2026-11-17T00:00:00.000+00:00');

    const res2 = parseQuickAdd('Ship build the day after tomorrow', makeOpts());
    expect(res2.title).toBe('Ship build');
    expect(res2.startDate).toBe('2026-11-17T00:00:00.000+00:00');
  });

  it('parses "yesterday"', () => {
    const res = parseQuickAdd('Log hours yesterday', makeOpts());
    expect(res.title).toBe('Log hours');
    expect(res.startDate).toBe('2026-11-14T00:00:00.000+00:00');
  });

  it('parses "tonight" as today at 8pm', () => {
    const res = parseQuickAdd('Read book tonight', makeOpts());
    expect(res.title).toBe('Read book');
    expect(res.startDate).toBe('2026-11-15T20:00:00.000+00:00');
    expect(res.isAllDay).toBe(false);
  });

  it('parses "in N days", "after N days", "in 1 week", "after 1 month", "in 2 years"', () => {
    expect(parseQuickAdd('Follow up in 3 days', makeOpts()).startDate).toBe('2026-11-18T00:00:00.000+00:00');
    expect(parseQuickAdd('Follow up after 3 days', makeOpts()).startDate).toBe('2026-11-18T00:00:00.000+00:00');
    expect(parseQuickAdd('Check in after 1 week', makeOpts()).startDate).toBe('2026-11-22T00:00:00.000+00:00');
    expect(parseQuickAdd('Review after 1 month', makeOpts()).startDate).toBe('2026-12-15T00:00:00.000+00:00');
    expect(parseQuickAdd('Renew passport in 2 years', makeOpts()).startDate).toBe('2028-11-15T00:00:00.000+00:00');
  });

  it('parses "in N hours", "after N hours", "in 30 minutes", "2 hours later"', () => {
    const r1 = parseQuickAdd('Check oven in 2 hours', makeOpts());
    expect(r1.title).toBe('Check oven');
    expect(r1.startDate).toBe('2026-11-15T16:00:00.000+00:00');
    expect(r1.isAllDay).toBe(false);

    const r2 = parseQuickAdd('Stand up after 2 hours', makeOpts());
    expect(r2.startDate).toBe('2026-11-15T16:00:00.000+00:00');

    const r3 = parseQuickAdd('Ping server in 30 minutes', makeOpts());
    expect(r3.startDate).toBe('2026-11-15T14:30:00.000+00:00');

    const r4 = parseQuickAdd('Take break 2 hours later', makeOpts());
    expect(r4.startDate).toBe('2026-11-15T16:00:00.000+00:00');
  });

  it('parses "in two days" and "half an hour later"', () => {
    expect(parseQuickAdd('Reply in two days', makeOpts()).startDate).toBe('2026-11-17T00:00:00.000+00:00');
    expect(parseQuickAdd('Check mail half an hour later', makeOpts()).startDate).toBe('2026-11-15T14:30:00.000+00:00');
  });

  it('respects target timeZone day boundaries when UTC and local dates differ', () => {
    // 2026-11-16 02:00 UTC is still Sunday 2026-11-15 21:00 EST (-05:00)
    const lateUtcNow = new Date('2026-11-16T02:00:00.000Z');
    const nyRes = parseQuickAdd('Buy coffee tomorrow', makeOpts({ now: lateUtcNow, timeZone: 'America/New_York' }));
    expect(nyRes.startDate).toBe('2026-11-16T00:00:00.000-05:00');

    const tokyoRes = parseQuickAdd('Buy coffee tomorrow', makeOpts({ now: lateUtcNow, timeZone: 'Asia/Tokyo' }));
    // In Tokyo (UTC+9), 02:00 UTC is already 11:00 on Nov 16, so tomorrow is Nov 17
    expect(tokyoRes.startDate).toBe('2026-11-17T00:00:00.000+09:00');
  });

  it('handles DST fall-back offset transitions accurately', () => {
    // 2026-11-01 05:30 UTC is 01:30 EDT (-04:00) before NY DST fall-back at 02:00
    const dstNow = new Date('2026-11-01T05:30:00.000Z');
    const res1 = parseQuickAdd('Meeting tomorrow at 9am', makeOpts({ now: dstNow, timeZone: 'America/New_York' }));
    expect(res1.startDate).toBe('2026-11-02T09:00:00.000-05:00');

    const res2 = parseQuickAdd('Alert in 2 hours', makeOpts({ now: dstNow, timeZone: 'America/New_York' }));
    // 05:30Z + 2h = 07:30Z -> 02:30 EST (-05:00)
    expect(res2.startDate).toBe('2026-11-01T02:30:00.000-05:00');
  });

  it('parses "next week" and "next month" respecting weekStart', () => {
    // Sunday Nov 15, 2026 with weekStart=0 -> next week starts Sun Nov 22
    expect(parseQuickAdd('Plan next week', makeOpts({ weekStart: 0 })).startDate).toBe('2026-11-22T00:00:00.000+00:00');
    // Sunday Nov 15, 2026 with weekStart=1 -> current week is Nov 9..15, next week starts Mon Nov 16
    expect(parseQuickAdd('Plan next week', makeOpts({ weekStart: 1 })).startDate).toBe('2026-11-16T00:00:00.000+00:00');
    expect(parseQuickAdd('Budget next month', makeOpts()).startDate).toBe('2026-12-01T00:00:00.000+00:00');
  });
});

describe('weekdays (this/next)', () => {
  it('parses bare upcoming weekdays from Sunday Nov 15', () => {
    const wed = parseQuickAdd('Team sync Wednesday', makeOpts());
    expect(wed.title).toBe('Team sync');
    expect(wed.startDate).toBe('2026-11-18T00:00:00.000+00:00');

    const fri = parseQuickAdd('Deploy on Friday', makeOpts());
    expect(fri.title).toBe('Deploy');
    expect(fri.startDate).toBe('2026-11-20T00:00:00.000+00:00');
  });

  it('distinguishes "this Monday" vs "next Monday" when weekStart is Sunday (0)', () => {
    // Now is Sunday Nov 15, 2026. Week (Sun..Sat) is Nov 15..21. Next week is Nov 22..28.
    const thisMon = parseQuickAdd('Report this Monday', makeOpts({ weekStart: 0 }));
    expect(thisMon.title).toBe('Report');
    expect(thisMon.startDate).toBe('2026-11-16T00:00:00.000+00:00');

    const nextMon = parseQuickAdd('Report next Monday', makeOpts({ weekStart: 0 }));
    expect(nextMon.title).toBe('Report');
    expect(nextMon.startDate).toBe('2026-11-23T00:00:00.000+00:00');
  });

  it('distinguishes "next Monday" when weekStart is Monday (1) on Sunday Nov 15', () => {
    // With weekStart=1, Sunday Nov 15 is the LAST day of current week (Nov 9..15).
    // Next week starts Monday Nov 16.
    const nextMon = parseQuickAdd('Report next Monday', makeOpts({ weekStart: 1 }));
    expect(nextMon.startDate).toBe('2026-11-16T00:00:00.000+00:00');

    const nextFri = parseQuickAdd('Demo next Friday', makeOpts({ weekStart: 1 }));
    expect(nextFri.startDate).toBe('2026-11-20T00:00:00.000+00:00');
  });

  it('distinguishes "this" vs "next" mid-week on Wednesday Nov 18', () => {
    const wedNow = new Date('2026-11-18T10:00:00.000Z');
    const thisFri = parseQuickAdd('Review this Friday', makeOpts({ now: wedNow, weekStart: 1 }));
    expect(thisFri.startDate).toBe('2026-11-20T00:00:00.000+00:00');

    const nextFri = parseQuickAdd('Review next Friday', makeOpts({ now: wedNow, weekStart: 1 }));
    expect(nextFri.startDate).toBe('2026-11-27T00:00:00.000+00:00');
  });

  it('handles weekStart=6 (Saturday start)', () => {
    // On Sunday Nov 15 with weekStart=6, current week is Sat Nov 14..Fri Nov 20; next week starts Sat Nov 21.
    const nextSat = parseQuickAdd('Errand next Saturday', makeOpts({ weekStart: 6 }));
    expect(nextSat.startDate).toBe('2026-11-21T00:00:00.000+00:00');

    const thisFri = parseQuickAdd('Errand this Friday', makeOpts({ weekStart: 6 }));
    expect(thisFri.startDate).toBe('2026-11-20T00:00:00.000+00:00');
  });

  it('parses "this weekend" vs "next weekend"', () => {
    const thisWk = parseQuickAdd('Hike this weekend', makeOpts({ weekStart: 0 }));
    expect(thisWk.startDate).toBe('2026-11-21T00:00:00.000+00:00');

    const nextWk = parseQuickAdd('Hike next weekend', makeOpts({ weekStart: 0 }));
    expect(nextWk.startDate).toBe('2026-11-28T00:00:00.000+00:00');
  });

  it('parses abbreviated weekdays when used with weekday context', () => {
    expect(parseQuickAdd('Call on Sat', makeOpts()).startDate).toBe('2026-11-21T00:00:00.000+00:00');
    expect(parseQuickAdd('Brunch next Sun', makeOpts({ weekStart: 0 })).startDate).toBe('2026-11-22T00:00:00.000+00:00');
    expect(parseQuickAdd('Sync Wed 10am', makeOpts()).startDate).toBe('2026-11-18T10:00:00.000+00:00');
    expect(parseQuickAdd('Standup Thu', makeOpts()).startDate).toBe('2026-11-19T00:00:00.000+00:00');
    expect(parseQuickAdd('Coffee Tue', makeOpts()).startDate).toBe('2026-11-17T00:00:00.000+00:00');
  });

  it('parses "last Friday"', () => {
    const res = parseQuickAdd('Log last Friday', makeOpts());
    expect(res.startDate).toBe('2026-11-13T00:00:00.000+00:00');
  });
});
