import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from '../src/index.js';
import { expectValidSpans, makeOpts } from './helpers.js';

// Reference now: Sunday 2026-11-15T14:00:00.000Z

describe('repeat phrases', () => {
  describe('daily, weekday, weekend, and workday rules', () => {
    it('parses every day / everyday / daily', () => {
      for (const phrase of ['Meditate every day', 'Meditate everyday', 'Meditate daily']) {
        const res = parseQuickAdd(phrase, makeOpts());
        expectValidSpans(phrase, res);
        expect(res.repeatFlag).toBe('RRULE:FREQ=DAILY;INTERVAL=1');
        expect(res.title).toBe('Meditate');
        expect(res.isAllDay).toBe(true);
        expect(res.startDate).toBe('2026-11-15T00:00:00.000+00:00');
        expect(res.recognized.some((r) => r.kind === 'repeat')).toBe(true);
      }
    });

    it('parses every weekday / weekdays / weekly on weekdays', () => {
      for (const phrase of ['Standup every weekday', 'Standup on weekdays', 'Standup every weekdays']) {
        const res = parseQuickAdd(phrase, makeOpts());
        expectValidSpans(phrase, res);
        expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR');
        expect(res.title).toBe('Standup');
        // Since now is Sunday 2026-11-15, first weekday on or after is Monday 2026-11-16
        expect(res.startDate).toBe('2026-11-16T00:00:00.000+00:00');
      }
    });

    it('parses every weekend / weekends', () => {
      const res = parseQuickAdd('Water plants every weekend', makeOpts());
      expectValidSpans('Water plants every weekend', res);
      expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SA,SU');
      expect(res.title).toBe('Water plants');
    });

    it('parses every workday / every working day with TT_SKIP=HOLIDAY,WEEKEND', () => {
      for (const phrase of ['Check inbox every workday', 'Check inbox every working day']) {
        const res = parseQuickAdd(phrase, makeOpts());
        expectValidSpans(phrase, res);
        expect(res.repeatFlag).toBe('RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=HOLIDAY,WEEKEND');
        expect(res.title).toBe('Check inbox');
        // Sunday -> next workday is Monday 2026-11-16
        expect(res.startDate).toBe('2026-11-16T00:00:00.000+00:00');
      }
    });
  });

  describe('weekly and named weekday recurrence', () => {
    it('parses every week / weekly / every monday', () => {
      const w = parseQuickAdd('Review metrics every week', makeOpts());
      expectValidSpans('Review metrics every week', w);
      expect(w.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1');
      expect(w.title).toBe('Review metrics');

      const w2 = parseQuickAdd('Clean desk weekly', makeOpts());
      expect(w2.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1');

      const m = parseQuickAdd('Team sync every Monday', makeOpts());
      expectValidSpans('Team sync every Monday', m);
      expect(m.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO');
      expect(m.startDate).toBe('2026-11-16T00:00:00.000+00:00');
      expect(m.title).toBe('Team sync');
    });

    it('parses multiple weekdays (every Mon/Wed/Fri, every Tue and Thu)', () => {
      const mwf = parseQuickAdd('Gym every Mon/Wed/Fri', makeOpts());
      expectValidSpans('Gym every Mon/Wed/Fri', mwf);
      expect(mwf.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR');
      expect(mwf.title).toBe('Gym');
      expect(mwf.startDate).toBe('2026-11-16T00:00:00.000+00:00');

      const tt = parseQuickAdd('Class every Tue and Thu', makeOpts());
      expectValidSpans('Class every Tue and Thu', tt);
      expect(tt.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH');
      expect(tt.title).toBe('Class');
      expect(tt.startDate).toBe('2026-11-17T00:00:00.000+00:00');
    });

    it('parses plural weekday repetition (on Mondays)', () => {
      const res = parseQuickAdd('Trash out on Mondays', makeOpts());
      expectValidSpans('Trash out on Mondays', res);
      expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO');
      expect(res.title).toBe('Trash out');
    });

    it('parses every N weeks with weekdays', () => {
      const res = parseQuickAdd('Payroll every 2 weeks on Mon & Wed', makeOpts());
      expectValidSpans('Payroll every 2 weeks on Mon & Wed', res);
      expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE');
      expect(res.title).toBe('Payroll');
    });
  });

  describe('every N units and frequency words', () => {
    it('parses every N days, weeks, months, years', () => {
      expect(parseQuickAdd('Pill every 3 days', makeOpts()).repeatFlag).toBe('RRULE:FREQ=DAILY;INTERVAL=3');
      expect(parseQuickAdd('Sheets every 2 weeks', makeOpts()).repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2');
      expect(parseQuickAdd('Filter every 5 months', makeOpts()).repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=5');
      expect(parseQuickAdd('Audit every 2 years', makeOpts()).repeatFlag).toBe('RRULE:FREQ=YEARLY;INTERVAL=2');
    });

    it('parses number words like every three days and every other day/week', () => {
      expect(parseQuickAdd('Water fern every three days', makeOpts()).repeatFlag).toBe('RRULE:FREQ=DAILY;INTERVAL=3');
      expect(parseQuickAdd('Run every other day', makeOpts()).repeatFlag).toBe('RRULE:FREQ=DAILY;INTERVAL=2');
      expect(parseQuickAdd('Sprint retro every other week', makeOpts()).repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2');
    });

    it('parses biweekly, bimonthly, quarterly, semi-annually', () => {
      expect(parseQuickAdd('Sync biweekly', makeOpts()).repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2');
      expect(parseQuickAdd('Newsletter bimonthly', makeOpts()).repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=2');
      expect(parseQuickAdd('OKRs quarterly', makeOpts()).repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=3');
      expect(parseQuickAdd('Dental checkup semi-annually', makeOpts()).repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=6');
    });
  });

  describe('monthly rules (Nth day, last day, ordinal weekday, workday)', () => {
    it('parses every month / monthly', () => {
      expect(parseQuickAdd('Pay rent every month', makeOpts()).repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1');
      expect(parseQuickAdd('Pay rent monthly', makeOpts()).repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1');
    });

    it('parses month on the Nth day variants', () => {
      for (const phrase of [
        'Pay rent every month on the 15th',
        'Pay rent on the 15th of every month',
        'Pay rent every 15th',
      ]) {
        const res = parseQuickAdd(phrase, makeOpts());
        expectValidSpans(phrase, res);
        expect(res.repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15');
        expect(res.title).toBe('Pay rent');
      }

      const first = parseQuickAdd('Invoice every 1st day of the month', makeOpts());
      expect(first.repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1');
    });

    it('parses last day of every month and end of every month', () => {
      const a = parseQuickAdd('Close books last day of every month', makeOpts());
      expectValidSpans('Close books last day of every month', a);
      expect(a.repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1');
      expect(a.title).toBe('Close books');
      expect(a.startDate).toBe('2026-11-30T00:00:00.000+00:00');

      const b = parseQuickAdd('Report every month on the last day', makeOpts());
      expect(b.repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1');

      const c = parseQuickAdd('Reconcile end of every month', makeOpts());
      expect(c.repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1');
    });

    it('parses ordinal weekdays of every month (1st Monday, 2nd Tuesday, last Friday)', () => {
      const m = parseQuickAdd('Town hall every 1st Monday of the month', makeOpts());
      expectValidSpans('Town hall every 1st Monday of the month', m);
      expect(m.repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=1MO');
      expect(m.title).toBe('Town hall');

      const t = parseQuickAdd('Patch day every month on the 2nd Tuesday', makeOpts());
      expect(t.repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=2TU');

      const f = parseQuickAdd('Demo last Friday of every month', makeOpts());
      expectValidSpans('Demo last Friday of every month', f);
      expect(f.repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=-1FR');
      expect(f.startDate).toBe('2026-11-27T00:00:00.000+00:00');
      expect(f.title).toBe('Demo');
    });

    it('parses first and last workday of every month (TT_WORKDAY)', () => {
      const fw = parseQuickAdd('Timesheet first workday of every month', makeOpts());
      expectValidSpans('Timesheet first workday of every month', fw);
      expect(fw.repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1;TT_WORKDAY=1');
      expect(fw.title).toBe('Timesheet');

      const lw = parseQuickAdd('Payroll every month on the last workday', makeOpts());
      expectValidSpans('Payroll every month on the last workday', lw);
      expect(lw.repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1;TT_WORKDAY=-1');
      expect(lw.title).toBe('Payroll');
    });
  });

  describe('yearly rules', () => {
    it('parses every year / yearly / annually', () => {
      expect(parseQuickAdd('Renew passport every year', makeOpts()).repeatFlag).toBe('RRULE:FREQ=YEARLY;INTERVAL=1');
      expect(parseQuickAdd('Renew license yearly', makeOpts()).repeatFlag).toBe('RRULE:FREQ=YEARLY;INTERVAL=1');
      expect(parseQuickAdd('Physical exam annually', makeOpts()).repeatFlag).toBe('RRULE:FREQ=YEARLY;INTERVAL=1');
    });

    it('parses yearly on month and day', () => {
      const a = parseQuickAdd('Anniversary every year on March 4', makeOpts());
      expectValidSpans('Anniversary every year on March 4', a);
      expect(a.repeatFlag).toBe('RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=4');
      expect(a.startDate).toBe('2027-03-04T00:00:00.000+00:00');
      expect(a.title).toBe('Anniversary');

      const b = parseQuickAdd('Birthday every March 4', makeOpts());
      expect(b.repeatFlag).toBe('RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=4');
    });

    it('parses yearly ordinal weekday of month (Mothers Day / Thanksgiving pattern)', () => {
      const mothers = parseQuickAdd('Call Mom every 2nd Sunday of May', makeOpts());
      expectValidSpans('Call Mom every 2nd Sunday of May', mothers);
      expect(mothers.repeatFlag).toBe('RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=5;BYDAY=2SU');
      expect(mothers.startDate).toBe('2027-05-09T00:00:00.000+00:00');
      expect(mothers.title).toBe('Call Mom');

      const thanks = parseQuickAdd('Dinner every 4th Thursday of November', makeOpts());
      expect(thanks.repeatFlag).toBe('RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYDAY=4TH');
      expect(thanks.startDate).toBe('2026-11-26T00:00:00.000+00:00');
    });
  });

  describe('end conditions and combined repeat phrases', () => {
    it('parses UNTIL end condition as YYYYMMDD', () => {
      const a = parseQuickAdd('Journal every day until 2026-12-31', makeOpts());
      expectValidSpans('Journal every day until 2026-12-31', a);
      expect(a.repeatFlag).toBe('RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20261231');
      expect(a.title).toBe('Journal');

      const b = parseQuickAdd('Swim every week until June 1', makeOpts());
      expectValidSpans('Swim every week until June 1', b);
      expect(b.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;UNTIL=20270601');
      expect(b.title).toBe('Swim');
    });

    it('parses COUNT end condition (for N times / xN)', () => {
      const a = parseQuickAdd('Practice piano every day for 5 times', makeOpts());
      expectValidSpans('Practice piano every day for 5 times', a);
      expect(a.repeatFlag).toBe('RRULE:FREQ=DAILY;INTERVAL=1;COUNT=5');
      expect(a.title).toBe('Practice piano');

      const b = parseQuickAdd('Physio every 2 days x6', makeOpts());
      expectValidSpans('Physio every 2 days x6', b);
      expect(b.repeatFlag).toBe('RRULE:FREQ=DAILY;INTERVAL=2;COUNT=6');
      expect(b.title).toBe('Physio');
    });

    it('parses duration-based end condition (every day for 2 weeks)', () => {
      const res = parseQuickAdd('Antibiotics every day for 2 weeks', makeOpts());
      expectValidSpans('Antibiotics every day for 2 weeks', res);
      // 14 daily occurrences inclusive starting 2026-11-15 ends on 2026-11-28
      expect(res.repeatFlag).toBe('RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20261128');
      expect(res.title).toBe('Antibiotics');
    });

    it('parses weekly repeat with for N weeks as COUNT=N', () => {
      const res = parseQuickAdd('Therapy every Monday for 4 weeks', makeOpts());
      expectValidSpans('Therapy every Monday for 4 weeks', res);
      expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;COUNT=4');
      expect(res.title).toBe('Therapy');
    });

    it('combines repeat with part-of-day or explicit time', () => {
      const a = parseQuickAdd('Standup every weekday at 9:30am', makeOpts());
      expectValidSpans('Standup every weekday at 9:30am', a);
      expect(a.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR');
      expect(a.isAllDay).toBe(false);
      expect(a.startDate).toBe('2026-11-16T09:30:00.000+00:00');
      expect(a.title).toBe('Standup');

      const b = parseQuickAdd('Vitamins every morning', makeOpts());
      expectValidSpans('Vitamins every morning', b);
      expect(b.repeatFlag).toBe('RRULE:FREQ=DAILY;INTERVAL=1');
      expect(b.isAllDay).toBe(false);
      expect(b.startDate).toMatch(/T09:00:00\.000\+00:00$/);
      expect(b.title).toBe('Vitamins');
    });
  });
});
