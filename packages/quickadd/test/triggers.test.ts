import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from '../src/index.js';
import { expectValidSpans, makeOpts } from './helpers.js';

// Reference now: Sunday 2026-11-15T14:00:00.000Z

describe('symbol triggers and fullwidth aliases', () => {
  describe('# tag triggers', () => {
    it('parses single tag and lowercases canonical tag name', () => {
      const res = parseQuickAdd('Write docs #Work', makeOpts());
      expectValidSpans('Write docs #Work', res);
      expect(res.tags).toEqual(['work']);
      expect(res.title).toBe('Write docs');
      expect(res.recognized).toEqual([{ start: 11, end: 16, kind: 'tag', text: '#Work' }]);
    });

    it('parses multiple tags and deduplicates case-insensitively', () => {
      const res = parseQuickAdd('Plan trip #Travel #personal #travel', makeOpts());
      expectValidSpans('Plan trip #Travel #personal #travel', res);
      expect(res.tags).toEqual(['travel', 'personal']);
      expect(res.title).toBe('Plan trip');
    });

    it('parses fullwidth hash trigger ＃', () => {
      const res = parseQuickAdd('Buy bread ＃Errands', makeOpts());
      expectValidSpans('Buy bread ＃Errands', res);
      expect(res.tags).toEqual(['errands']);
      expect(res.title).toBe('Buy bread');
    });

    it('stops tag token at forbidden characters (/, ?, etc.)', () => {
      const res = parseQuickAdd('Fix bug #ops/prod soon', makeOpts());
      expectValidSpans('Fix bug #ops/prod soon', res);
      expect(res.tags).toEqual(['ops']);
    });

    it('matches canonical tag from opts.tags when provided', () => {
      const res = parseQuickAdd('Clean desk #home-office', makeOpts({ tags: ['Home-Office', 'work'] }));
      expect(res.tags).toEqual(['home-office']);
      expect(res.title).toBe('Clean desk');
    });

    it('handles bare # followed by space as literal text', () => {
      const res = parseQuickAdd('Issue # 42', makeOpts());
      expect(res.tags).toEqual([]);
      expect(res.title).toBe('Issue # 42');
    });
  });

  describe('! priority triggers (words, numbers, and bangs)', () => {
    it('parses !high, !medium, !low, !none case-insensitively', () => {
      expect(parseQuickAdd('Task !High', makeOpts()).priority).toBe(5);
      expect(parseQuickAdd('Task !medium', makeOpts()).priority).toBe(3);
      expect(parseQuickAdd('Task !LOW', makeOpts()).priority).toBe(1);
      expect(parseQuickAdd('Task !None', makeOpts()).priority).toBe(0);
    });

    it('parses !1 -> 5, !2 -> 3, !3 -> 1, !4 -> 0', () => {
      expect(parseQuickAdd('A !1', makeOpts()).priority).toBe(5);
      expect(parseQuickAdd('B !2', makeOpts()).priority).toBe(3);
      expect(parseQuickAdd('C !3', makeOpts()).priority).toBe(1);
      expect(parseQuickAdd('D !4', makeOpts()).priority).toBe(0);
    });

    it('parses !! as medium (3) and !!! as high (5)', () => {
      const med = parseQuickAdd('Reply to email !!', makeOpts());
      expectValidSpans('Reply to email !!', med);
      expect(med.priority).toBe(3);
      expect(med.title).toBe('Reply to email');

      const high = parseQuickAdd('Server down !!!', makeOpts());
      expectValidSpans('Server down !!!', high);
      expect(high.priority).toBe(5);
      expect(high.title).toBe('Server down');
    });

    it('parses fullwidth ！ priority', () => {
      const a = parseQuickAdd('Submit report ！High', makeOpts());
      expect(a.priority).toBe(5);
      expect(a.title).toBe('Submit report');

      const b = parseQuickAdd('Review PR ！2', makeOpts());
      expect(b.priority).toBe(3);
    });

    it('ignores bare single ! and unrecognized !words', () => {
      const a = parseQuickAdd('Happy birthday!', makeOpts());
      expect(a.priority).toBeUndefined();
      expect(a.title).toBe('Happy birthday!');

      const b = parseQuickAdd('Wait !what happened', makeOpts());
      expect(b.priority).toBeUndefined();
    });
  });

  describe('~ and ^ list triggers', () => {
    it('parses ~ListName and ^ListName', () => {
      const a = parseQuickAdd('Buy milk ~Groceries', makeOpts());
      expectValidSpans('Buy milk ~Groceries', a);
      expect(a.list).toBe('Groceries');
      expect(a.title).toBe('Buy milk');
      expect(a.recognized[0]?.kind).toBe('list');

      const b = parseQuickAdd('Deploy fix ^Engineering', makeOpts());
      expect(b.list).toBe('Engineering');
      expect(b.title).toBe('Deploy fix');
    });

    it('parses fullwidth ～ and ＾ list triggers', () => {
      expect(parseQuickAdd('Pay bill ～Finance', makeOpts()).list).toBe('Finance');
      expect(parseQuickAdd('Read book ＾Inbox', makeOpts()).list).toBe('Inbox');
    });

    it('matches multi-word list names from opts.lists longest-first', () => {
      const res = parseQuickAdd(
        'Paint kitchen ~Home Renovations tomorrow',
        makeOpts({ lists: ['Home', 'Home Renovations', 'Work'] }),
      );
      expectValidSpans('Paint kitchen ~Home Renovations tomorrow', res);
      expect(res.list).toBe('Home Renovations');
      expect(res.startDate).toBe('2026-11-16T00:00:00.000+00:00');
      expect(res.title).toBe('Paint kitchen');
    });
  });

  describe('@ assignee triggers', () => {
    it('parses @assignee and fullwidth ＠assignee', () => {
      const a = parseQuickAdd('Review spec @alice', makeOpts());
      expectValidSpans('Review spec @alice', a);
      expect(a.assignee).toBe('alice');
      expect(a.title).toBe('Review spec');
      expect(a.recognized[0]?.kind).toBe('assignee');

      const b = parseQuickAdd('Check logs ＠bob', makeOpts());
      expect(b.assignee).toBe('bob');
      expect(b.title).toBe('Check logs');
    });

    it('matches multi-word assignee from opts.assignees', () => {
      const res = parseQuickAdd(
        'Prepare slides @Alice Smith on Friday',
        makeOpts({ assignees: ['Alice', 'Alice Smith'] }),
      );
      expectValidSpans('Prepare slides @Alice Smith on Friday', res);
      expect(res.assignee).toBe('Alice Smith');
      expect(res.startDate).toBe('2026-11-20T00:00:00.000+00:00');
      expect(res.title).toBe('Prepare slides');
    });
  });

  describe('chained triggers and order independence', () => {
    it('splits adjacent chained triggers without spaces', () => {
      const input = 'Ship release #work!high~Product@alice';
      const res = parseQuickAdd(input, makeOpts());
      expectValidSpans(input, res);
      expect(res.tags).toEqual(['work']);
      expect(res.priority).toBe(5);
      expect(res.list).toBe('Product');
      expect(res.assignee).toBe('alice');
      expect(res.title).toBe('Ship release');
    });

    it('supports chained fullwidth triggers', () => {
      const input = 'Audit ＃security！1～Ops＠trevor';
      const res = parseQuickAdd(input, makeOpts());
      expectValidSpans(input, res);
      expect(res.tags).toEqual(['security']);
      expect(res.priority).toBe(5);
      expect(res.list).toBe('Ops');
      expect(res.assignee).toBe('trevor');
      expect(res.title).toBe('Audit');
    });

    it('preserves priority=3 when !! appears immediately before #tag or ~list', () => {
      const res = parseQuickAdd('Check alerts !!#ops', makeOpts());
      expectValidSpans('Check alerts !!#ops', res);
      expect(res.priority).toBe(3);
      expect(res.tags).toEqual(['ops']);
      expect(res.title).toBe('Check alerts');
    });
  });

  describe('* and ＊ forced date prefix', () => {
    it('forces date parsing with *tomorrow and removes * from title', () => {
      const res = parseQuickAdd('Renew cert *tomorrow', makeOpts());
      expectValidSpans('Renew cert *tomorrow', res);
      expect(res.startDate).toBe('2026-11-16T00:00:00.000+00:00');
      expect(res.isAllDay).toBe(true);
      expect(res.title).toBe('Renew cert');
    });

    it('forces ambiguous month word *may to parse as May 1', () => {
      const res = parseQuickAdd('Garden prep *may', makeOpts());
      expectValidSpans('Garden prep *may', res);
      expect(res.startDate).toBe('2027-05-01T00:00:00.000+00:00');
      expect(res.title).toBe('Garden prep');
    });

    it('forces ambiguous *march to parse as March 1', () => {
      const res = parseQuickAdd('Taxes *march', makeOpts());
      expectValidSpans('Taxes *march', res);
      expect(res.startDate).toBe('2027-03-01T00:00:00.000+00:00');
      expect(res.title).toBe('Taxes');
    });

    it('forces *next month and *next year', () => {
      const nm = parseQuickAdd('Budget *next month', makeOpts());
      expectValidSpans('Budget *next month', nm);
      expect(nm.startDate).toBe('2026-12-01T00:00:00.000+00:00');
      expect(nm.title).toBe('Budget');

      const ny = parseQuickAdd('Goals *next year', makeOpts());
      expectValidSpans('Goals *next year', ny);
      expect(ny.startDate).toBe('2027-01-01T00:00:00.000+00:00');
    });

    it('forces *tomorrow 3pm including time', () => {
      const res = parseQuickAdd('Meetup *tomorrow 3pm', makeOpts());
      expectValidSpans('Meetup *tomorrow 3pm', res);
      expect(res.isAllDay).toBe(false);
      expect(res.startDate).toBe('2026-11-16T15:00:00.000+00:00');
      expect(res.title).toBe('Meetup');
    });

    it('supports fullwidth ＊ forced date prefix', () => {
      const res = parseQuickAdd('Call＊next friday', makeOpts());
      expectValidSpans('Call＊next friday', res);
      expect(res.startDate).toBe('2026-11-27T00:00:00.000+00:00');
      expect(res.title).toBe('Call');
    });
  });
});
