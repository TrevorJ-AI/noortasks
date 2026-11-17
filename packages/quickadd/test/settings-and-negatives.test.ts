import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from '../src/index.js';
import { expectValidSpans, makeOpts } from './helpers.js';

// Reference now: Sunday 2026-11-15T14:00:00.000Z

describe('settings, disabledSpans, and negative / false-positive guards', () => {
  describe('disabledSpans', () => {
    it('disables a recognized date span while keeping title intact', () => {
      const text = 'Call Bob tomorrow at 3pm';
      const first = parseQuickAdd(text, makeOpts());
      const dateSpan = first.recognized.find((r) => r.kind === 'date');
      expect(dateSpan).toBeDefined();

      const second = parseQuickAdd(text, makeOpts({ disabledSpans: [[dateSpan!.start, dateSpan!.end]] }));
      expectValidSpans(text, second);
      // Date span ("tomorrow") was disabled so startDate falls back to today + 3pm
      expect(second.startDate).toBe('2026-11-15T15:00:00.000+00:00');
      expect(second.title).toBe('Call Bob tomorrow');
    });

    it('disables a whole date+time expression completely', () => {
      const text = 'Meeting tomorrow 3pm';
      const idx = text.indexOf('tomorrow 3pm');
      const res = parseQuickAdd(text, makeOpts({ disabledSpans: [[idx, text.length]] }));
      expect(res.startDate).toBeUndefined();
      expect(res.dueDate).toBeUndefined();
      expect(res.recognized).toEqual([]);
      expect(res.title).toBe('Meeting tomorrow 3pm');
    });

    it('disables partial seam of a compound date token without re-parsing the remainder', () => {
      const text = 'Version 2026-12-01';
      // Disable just "2026-" (8..13)
      const start = text.indexOf('2026-');
      const res = parseQuickAdd(text, makeOpts({ disabledSpans: [[start, start + 5]] }));
      expect(res.startDate).toBeUndefined();
      expect(res.recognized).toEqual([]);
      expect(res.title).toBe(text);
    });

    it('disables a repeat phrase when its span is disabled', () => {
      const text = 'Run every day at 7am';
      const start = text.indexOf('every day');
      const res = parseQuickAdd(text, makeOpts({ disabledSpans: [[start, start + 9]] }));
      expect(res.repeatFlag).toBeUndefined();
      expect(res.title).toContain('every day');
      expect(res.isAllDay).toBe(false);
    });

    it('disables a symbol trigger when its span is disabled', () => {
      const text = 'Write report #work !high';
      const start = text.indexOf('#work');
      const res = parseQuickAdd(text, makeOpts({ disabledSpans: [[start, start + 5]] }));
      expect(res.tags).toEqual([]);
      expect(res.priority).toBe(5);
      expect(res.title).toBe('Write report #work');
    });

    it('ignores invalid or inverted disabledSpans gracefully', () => {
      const res = parseQuickAdd('Meeting tomorrow', makeOpts({ disabledSpans: [[5, 5], [10, 3], [-2, -1]] }));
      expect(res.startDate).toBe('2026-11-16T00:00:00.000+00:00');
      expect(res.title).toBe('Meeting');
    });
  });

  describe('removeRecognizedText setting', () => {
    it('keeps date, time, repeat, and reminder text in title when removeRecognizedText is false', () => {
      const text = 'Dentist tomorrow at 3pm remind me #health !high ~Personal @me';
      const res = parseQuickAdd(text, makeOpts({ removeRecognizedText: false }));
      expectValidSpans(text, res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-16T15:00:00.000+00:00');
      expect(res.reminders).toEqual(['TRIGGER:PT0S']);
      expect(res.tags).toEqual(['health']);
      expect(res.priority).toBe(5);
      expect(res.list).toBe('Personal');
      expect(res.assignee).toBe('me');
      // Date/time/reminder remain in title; symbol triggers (#/!/~/@) are always stripped
      expect(res.title).toBe('Dentist tomorrow at 3pm remind me');
    });

    it('keeps repeat phrase in title when removeRecognizedText is false', () => {
      const text = 'Water plants every Monday';
      const res = parseQuickAdd(text, makeOpts({ removeRecognizedText: false }));
      expect(res.repeatFlag).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO');
      expect(res.title).toBe('Water plants every Monday');
    });
  });

  describe('dateParsing setting (nlpEnabled = false)', () => {
    it('does not parse natural dates, times, repeats, or reminders when dateParsing is false', () => {
      const text = 'Meeting tomorrow at 3pm every week remind me #work !1';
      const res = parseQuickAdd(text, makeOpts({ dateParsing: false }));
      expectValidSpans(text, res);
      expect(res.startDate).toBeUndefined();
      expect(res.dueDate).toBeUndefined();
      expect(res.isAllDay).toBeUndefined();
      expect(res.repeatFlag).toBeUndefined();
      expect(res.reminders).toBeUndefined();
      expect(res.tags).toEqual(['work']);
      expect(res.priority).toBe(5);
      expect(res.title).toBe('Meeting tomorrow at 3pm every week remind me');
    });

    it('still honors explicit * forced dates when dateParsing is false', () => {
      const text = 'Pay bill *tomorrow #finance';
      const res = parseQuickAdd(text, makeOpts({ dateParsing: false }));
      expectValidSpans(text, res);
      expect(res.startDate).toBe('2026-11-16T00:00:00.000+00:00');
      expect(res.isAllDay).toBe(true);
      expect(res.tags).toEqual(['finance']);
      expect(res.title).toBe('Pay bill');
    });
  });

  describe('titles that must NOT parse (false-positive prevention)', () => {
    const noParseCases = [
      'Buy 12 apples',
      'Room 405',
      'Budget 2026',
      'Invoice 20261115',
      'Amount $12.50',
      'Upgrade to v2.10.3',
      'Server 192.168.1.1 down',
      'Reference 123-456-789',
      'Part P12-3 arrived',
      'Key AAAA-BBBB-CCCC-DDDD',
      'Date 2026-13-01 typo',
      'Deadline May 32 invalid',
      'Invalid Feb 30 date',
      'Add 1/2 cup sugar',
      'Use 3/4 inch pipe',
      'See https://example.com/2026-05-01/tomorrow#top?at=3pm',
      'Visit www.test.org/tomorrow#tag!high',
      'Email alice@example.com about specs',
      'I may go to the store',
      'May I help you with that',
      'March forward together',
      'Join the peace march',
      'I sat down quietly',
      'He sat on the wooden chair',
      'Study for SAT prep',
      'Walk in the sun',
      'They plan to wed',
      'Wait a second please',
      'Save for 6 months',
      'Go to the 2nd floor',
      'Buy lunch',
      'Call June about slides',
      'Every single time',
      'Happy birthday!',
    ];

    for (const phrase of noParseCases) {
      it(`does not misparse "${phrase}"`, () => {
        const res = parseQuickAdd(phrase, makeOpts());
        expect(res.startDate).toBeUndefined();
        expect(res.dueDate).toBeUndefined();
        expect(res.repeatFlag).toBeUndefined();
        expect(res.reminders).toBeUndefined();
        expect(res.priority).toBeUndefined();
        expect(res.tags).toEqual([]);
        expect(res.list).toBeUndefined();
        expect(res.assignee).toBeUndefined();
        expect(res.recognized).toEqual([]);
        expect(res.title).toBe(phrase);
      });
    }
  });

  describe('combined real-world quick-add inputs', () => {
    it('parses full task with date, time range, repeat, reminder, priority, tag, list, and assignee', () => {
      const input = 'Quarterly sync every month on the 1st at 10am-11am 15m before #Work !high ~Team @alice';
      const res = parseQuickAdd(input, makeOpts());
      expectValidSpans(input, res);
      expect(res.title).toBe('Quarterly sync');
      expect(res.repeatFlag).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1');
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-12-01T10:00:00.000+00:00');
      expect(res.dueDate).toBe('2026-12-01T11:00:00.000+00:00');
      expect(res.reminders).toEqual(['TRIGGER:-PT15M']);
      expect(res.tags).toEqual(['work']);
      expect(res.priority).toBe(5);
      expect(res.list).toBe('Team');
      expect(res.assignee).toBe('alice');
    });

    it('handles empty or whitespace-only input', () => {
      const empty = parseQuickAdd('', makeOpts());
      expect(empty.title).toBe('');
      expect(empty.tags).toEqual([]);
      expect(empty.recognized).toEqual([]);

      const ws = parseQuickAdd('   ', makeOpts());
      expect(ws.title).toBe('');
      expect(ws.recognized).toEqual([]);
    });

    it('removes leading/trailing recognized tokens cleanly without leaving orphan prepositions', () => {
      const res = parseQuickAdd('On Friday at 5pm submit expense report', makeOpts());
      expectValidSpans('On Friday at 5pm submit expense report', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-20T17:00:00.000+00:00');
      expect(res.title).toBe('submit expense report');
    });
  });
});
