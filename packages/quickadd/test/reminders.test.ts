import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from '../src/index.js';
import { expectValidSpans, makeOpts } from './helpers.js';

// Reference now: Sunday 2026-11-15T14:00:00.000Z

describe('reminder phrases', () => {
  describe('default "remind me" triggers', () => {
    it('formats "remind me" on timed task as TRIGGER:PT0S', () => {
      const res = parseQuickAdd('Call Bob tomorrow at 3pm remind me', makeOpts());
      expectValidSpans('Call Bob tomorrow at 3pm remind me', res);
      expect(res.isAllDay).toBe(false);
      expect(res.reminders).toEqual(['TRIGGER:PT0S']);
      expect(res.title).toBe('Call Bob');
      expect(res.recognized.some((r) => r.kind === 'reminder')).toBe(true);
    });

    it('formats "reminds me" on all-day task as 09:00 TRIGGER:P0DT9H0M0S', () => {
      const res = parseQuickAdd('Pay rent tomorrow reminds me', makeOpts());
      expectValidSpans('Pay rent tomorrow reminds me', res);
      expect(res.isAllDay).toBe(true);
      expect(res.reminders).toEqual(['TRIGGER:P0DT9H0M0S']);
      expect(res.title).toBe('Pay rent');
    });

    it('combines "remind me in 10 minutes" with explicit offset date', () => {
      const res = parseQuickAdd('Take pie out remind me in 10 minutes', makeOpts());
      expectValidSpans('Take pie out remind me in 10 minutes', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T14:10:00.000+00:00');
      expect(res.reminders).toEqual(['TRIGGER:PT0S']);
      expect(res.title).toBe('Take pie out');
    });

    it('combines "remind me at 5pm" with time', () => {
      const res = parseQuickAdd('Send invoice remind me at 5pm', makeOpts());
      expectValidSpans('Send invoice remind me at 5pm', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-15T17:00:00.000+00:00');
      expect(res.reminders).toEqual(['TRIGGER:PT0S']);
      expect(res.title).toBe('Send invoice');
    });
  });

  describe('timed relative reminders (before / ahead / early / in advance)', () => {
    it('parses N minutes before', () => {
      const res = parseQuickAdd('Meeting tomorrow at 2pm 15 minutes before', makeOpts());
      expectValidSpans('Meeting tomorrow at 2pm 15 minutes before', res);
      expect(res.reminders).toEqual(['TRIGGER:-PT15M']);
      expect(res.title).toBe('Meeting');
    });

    it('parses compact Nm early / before', () => {
      const res = parseQuickAdd('Demo tomorrow 10am 15m early', makeOpts());
      expectValidSpans('Demo tomorrow 10am 15m early', res);
      expect(res.reminders).toEqual(['TRIGGER:-PT15M']);
      expect(res.title).toBe('Demo');
    });

    it('parses N hours before (converted to -PT<m>M per pwn format)', () => {
      const res = parseQuickAdd('Flight tomorrow 3pm 1 hour before', makeOpts());
      expectValidSpans('Flight tomorrow 3pm 1 hour before', res);
      expect(res.reminders).toEqual(['TRIGGER:-PT60M']);
      expect(res.title).toBe('Flight');
    });

    it('parses N seconds before', () => {
      const res = parseQuickAdd('Auction tomorrow 8pm 30 seconds before', makeOpts());
      expectValidSpans('Auction tomorrow 8pm 30 seconds before', res);
      expect(res.reminders).toEqual(['TRIGGER:-PT30S']);
    });

    it('parses N days before on timed task as TRIGGER:-P<d>D', () => {
      const res = parseQuickAdd('Interview Friday at 10am 1 day before', makeOpts());
      expectValidSpans('Interview Friday at 10am 1 day before', res);
      expect(res.reminders).toEqual(['TRIGGER:-P1D']);
      expect(res.title).toBe('Interview');
    });

    it('parses N weeks before on timed task as 7*N days', () => {
      const res = parseQuickAdd('Summit Dec 20 at 9am 2 weeks in advance', makeOpts());
      expectValidSpans('Summit Dec 20 at 9am 2 weeks in advance', res);
      expect(res.reminders).toEqual(['TRIGGER:-P14D']);
      expect(res.title).toBe('Summit');
    });

    it('parses ahead of time / beforehand suffixes', () => {
      const a = parseQuickAdd('Call tomorrow 4pm 30 mins ahead', makeOpts());
      expect(a.reminders).toEqual(['TRIGGER:-PT30M']);
      expect(a.title).toBe('Call');

      const b = parseQuickAdd('Prep tomorrow 4pm 20 minutes beforehand', makeOpts());
      expect(b.reminders).toEqual(['TRIGGER:-PT20M']);
    });
  });

  describe('all-day reminders (anchored at 09:00)', () => {
    it('shifts 1 day before all-day task to 24h before 09:00 (-P0DT15H0M0S)', () => {
      const res = parseQuickAdd('Passport renewal Dec 1 1 day before', makeOpts());
      expectValidSpans('Passport renewal Dec 1 1 day before', res);
      expect(res.isAllDay).toBe(true);
      expect(res.reminders).toEqual(['TRIGGER:-P0DT15H0M0S']);
      expect(res.title).toBe('Passport renewal');
    });

    it('shifts 3 days before all-day task to -P2DT15H0M0S', () => {
      const res = parseQuickAdd('Tax deadline Dec 15 3 days before', makeOpts());
      expectValidSpans('Tax deadline Dec 15 3 days before', res);
      expect(res.isAllDay).toBe(true);
      expect(res.reminders).toEqual(['TRIGGER:-P2DT15H0M0S']);
    });

    it('shifts 15 minutes before all-day task to 08:45 (P0DT8H45M0S)', () => {
      const res = parseQuickAdd('Bills tomorrow 15 minutes before', makeOpts());
      expectValidSpans('Bills tomorrow 15 minutes before', res);
      expect(res.isAllDay).toBe(true);
      expect(res.reminders).toEqual(['TRIGGER:P0DT8H45M0S']);
    });
  });

  describe('half-unit reminders', () => {
    it('maps 0.5h / half an hour to -PT30M', () => {
      const a = parseQuickAdd('Stream tomorrow 7pm 0.5h before', makeOpts());
      expect(a.reminders).toEqual(['TRIGGER:-PT30M']);

      const b = parseQuickAdd('Stream tomorrow 7pm half an hour before', makeOpts());
      expect(b.reminders).toEqual(['TRIGGER:-PT30M']);
    });

    it('maps half a minute and half a week (0.5m->30s, 0.5w->3d)', () => {
      const m = parseQuickAdd('Timer tomorrow 7pm half a minute before', makeOpts());
      expect(m.reminders).toEqual(['TRIGGER:-PT30S']);

      const w = parseQuickAdd('Trip Dec 1 at 10am half a week before', makeOpts());
      expect(w.reminders).toEqual(['TRIGGER:-P3D']);
    });

    it('maps half a month to 15 days and 0.5 day to 12 hours', () => {
      const mo = parseQuickAdd('Lease Dec 30 at 9am 0.5 month before', makeOpts());
      expect(mo.reminders).toEqual(['TRIGGER:-P15D']);

      const d = parseQuickAdd('Meeting tomorrow 6pm half a day before', makeOpts());
      expect(d.reminders).toEqual(['TRIGGER:-PT720M']);
    });
  });

  describe('multiple and deduplicated reminders', () => {
    it('collects multiple distinct reminders in order', () => {
      const res = parseQuickAdd('Webinar tomorrow 2pm 15 minutes before and remind me', makeOpts());
      expectValidSpans('Webinar tomorrow 2pm 15 minutes before and remind me', res);
      expect(res.reminders).toEqual(['TRIGGER:-PT15M', 'TRIGGER:PT0S']);
    });

    it('deduplicates identical triggers', () => {
      const res = parseQuickAdd('Webinar tomorrow 2pm 15m before and 15 minutes early', makeOpts());
      expect(res.reminders).toEqual(['TRIGGER:-PT15M']);
    });
  });
});
