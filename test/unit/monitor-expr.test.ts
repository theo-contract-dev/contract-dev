import { parseUntil } from '../../src/cli/monitor-expr';

describe('monitor snoozes', () => {
    it('parseUntil takes durations and dates', () => {
        const now = new Date('2026-09-16T12:00:00Z');
        expect(parseUntil('30m', now).toISOString()).toBe('2026-09-16T12:30:00.000Z');
        expect(parseUntil('2h', now).toISOString()).toBe('2026-09-16T14:00:00.000Z');
        expect(parseUntil('1d', now).toISOString()).toBe('2026-09-17T12:00:00.000Z');
        expect(parseUntil('2026-10-01T00:00:00Z', now).toISOString()).toBe('2026-10-01T00:00:00.000Z');
        expect(() => parseUntil('soon', now)).toThrow(/duration/);
    });
});
