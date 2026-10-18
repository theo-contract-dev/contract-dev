import { monitorCommand, parseDuration, buildIntent, backtestLines } from '../../src/cli/commands/monitor';
import { parseFlags } from '../../src/cli/commands/_args';
import { run } from '../../src/cli/index';
import { mockApi, useEnvAuth, printed } from './_mockApi';

// A monitor from a sentence: the flags become the intent compile_monitor / create_monitor take,
// and the compiled answer prints as the composer shows it.
const STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';
const ZERO = '0x0000000000000000000000000000000000000000';
const SENDER = '0xd6ad03f7d331750a4cca95203e5a1b43c2d2cfac';
const TX = (c: string) => `0x${c.repeat(64)}`;

const firing = (c: string, at: string, value: string) => ({ txHash: TX(c), at, blockNumber: 23_000_000, from: SENDER, args: { from: '0x1111…1111', to: '0x2222…2222', value } });
const compiled = {
    body: { name: 'Big transfers', watch: { kind: 'eventFired', chainId: 1, address: STETH }, channelIds: ['ch2', 'ch1'], notifyAll: false },
    name: 'Big transfers',
    sentence: 'Big transfers: Transfer is emitted where value is at least 1,000 stETH and to is not 0x0000…0000',
    contract: { chainId: 1, address: STETH, name: 'Lido: stETH' },
    conditions: ['value at least 1,000 stETH', `to is not ${ZERO}`],
    channelIds: ['ch2', 'ch1'],
    backtest: {
        window: '7d',
        matches: 12,
        recent: [firing('a', '2026-10-12T03:19:00.000Z', '1,500 stETH'), firing('b', '2026-10-11T22:00:00.000Z', '2,000 stETH'), firing('c', '2026-10-10T09:45:00.000Z', '1,001 stETH')],
    },
    notes: ['value: compared in base units (no token unit could be resolved for this field).'],
};
const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 40 } });

describe('monitor compile', () => {
    useEnvAuth();

    it('parseDuration: minutes, hours, days, weeks, seconds; a minute to 30 days', () => {
        expect(parseDuration('90m')).toBe(5400);
        expect(parseDuration('24h')).toBe(86_400);
        expect(parseDuration('3d')).toBe(259_200);
        expect(parseDuration('1w')).toBe(604_800);
        expect(parseDuration('120 sec')).toBe(120);
        expect(parseDuration('6 hours')).toBe(21_600);
        expect(() => parseDuration('30s')).toThrow(/between 1 minute and 30 days/);
        expect(() => parseDuration('31d')).toThrow(/between 1 minute and 30 days/);
        expect(() => parseDuration('soon')).toThrow(/--for must be a duration like 90m, 24h or 3d/);
    });

    it('buildIntent carries only what was given; backtestLines caps the firings at three', () => {
        expect(buildIntent(parseFlags(['--on', 'steth', '--event', 'Transfer']))).toEqual({ mode: 'event', contract: 'steth', event: 'Transfer' });
        expect(buildIntent(parseFlags(['--on', 'steth', '--silence', '--to', 'ch1', '--name', ' Quiet ']))).toEqual({ mode: 'silence', contract: 'steth', name: 'Quiet', destinations: ['ch1'] });
        const many = { window: '7d', matches: 1, recent: [firing('a', '2026-10-12T03:19:00.000Z', '1'), firing('b', '2026-10-12T03:19:00.000Z', '2'), firing('c', '2026-10-12T03:19:00.000Z', '3'), firing('d', '2026-10-12T03:19:00.000Z', '4')] };
        expect(backtestLines(many)).toHaveLength(4);
        expect(backtestLines(many)[0]).toBe('  backtest:    Would have fired 1 time in 7 days');
        expect(backtestLines({ window: '7d', matches: 0, recent: [] })).toEqual(['  backtest:    Would have fired 0 times in 7 days']);
        expect(backtestLines(null)).toEqual(['  backtest:    unavailable']);
    });
});

describe('monitor add from a sentence', () => {
    useEnvAuth();

    it('--event calls create_monitor with the intent and prints the sentence and the id: saving replays nothing', async () => {
        const created = { monitor: { id: 'inv9', name: 'Big transfers', kind: 'eventFired', status: 'warming' }, sentence: compiled.sentence, backtest: null };
        const calls = mockApi({ 'POST /api/mainnet/tools/create_monitor': () => ok(created) });
        const result = await monitorCommand(['add', '--on', 'steth', '--event', 'Transfer', '--when', 'amount(value, emitter()) >= 1000', '--to', '#alerts', '--name', 'Big transfers']);
        expect(calls.map((c) => c.path)).toEqual(['/api/mainnet/tools/create_monitor']);
        expect(calls[0].body).toEqual({ input: { mode: 'event', contract: 'steth', event: 'Transfer', when: 'amount(value, emitter()) >= 1000', name: 'Big transfers', destinations: ['#alerts'] } });
        const out = printed();
        expect(out).toEqual([compiled.sentence, 'Created monitor "Big transfers" (inv9).']);
        expect(result).toEqual(created);
    });

    it('a capped replay says it read the newest events only, not the whole week', () => {
        expect(backtestLines({ window: '7d', matches: 2, recent: [], scanned: 20_000, capped: true })[0]).toBe('  backtest:    Would have fired 2 times in the newest 20,000 events read (less than 7 days: the week holds more)');
    });

    it('--silence saves a silence monitor; the plan cap comes back in the server\'s words', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/create_monitor': () => ok({ monitor: { id: 'inv10', name: 'No submit on Lido: stETH' }, sentence: 'submit has not been seen for 6 hours', backtest: { window: '7d', occurrences: 3, lastSeenAt: null } }) });
        await run(['monitor', 'add', '--on', 'steth', '--silence', '--method', 'submit', '--for', '6h', '--to', 'telegram']);
        expect(calls[0].body).toEqual({ input: { mode: 'silence', contract: 'steth', method: 'submit', windowSec: 21_600, destinations: ['telegram'] } });
        expect(printed()).toEqual(['submit has not been seen for 6 hours', '  backtest:    Seen 3 times in 7 days', 'Created monitor "No submit on Lido: stETH" (inv10).']);

        mockApi({ 'POST /api/mainnet/tools/create_monitor': () => ({ status: 403, payload: { ok: false, error: 'This workspace has used all of its monitors.', code: 'UPGRADE_REQUIRED' } }) });
        await expect(monitorCommand(['add', '--on', 'steth', '--event', 'Transfer'])).rejects.toThrow('This workspace has used all of its monitors.');
    });
});

describe('monitor add --group and delete several', () => {
    useEnvAuth();
    const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 7 } });

    it('--group makes one monitor per contract in one call; --yes passes the many-at-once check', async () => {
        const set = {
            monitors: 3,
            sentence: 'Upgraded is emitted',
            created: [
                { id: 'a1', name: 'Upgrade · stETH', contract: 'stETH' },
                { id: 'a2', name: 'Upgrade · wstETH', contract: 'wstETH' },
                { id: 'a3', name: 'Upgrade · Withdrawal Queue', contract: 'Withdrawal Queue' },
            ],
            failed: [],
            skippedCount: 2,
            skipped: [{ contract: 'GateSeal', reason: 'no ABI known' }],
        };
        const calls = mockApi({ 'POST /api/mainnet/tools/create_monitor': () => ok(set) });
        const result = await monitorCommand(['add', '--group', 'Lido', '--event', 'Upgraded', '--name', 'Upgrade', '--yes']);
        expect(calls[0].body).toEqual({ input: { mode: 'event', group: 'Lido', event: 'Upgraded', name: 'Upgrade', confirmMany: true } });
        expect(printed()).toEqual(['Upgraded is emitted', 'Created 3 monitors in Lido, one on each contract that has it.', 'Left out 2 contracts that do not have it.', '  no ABI known: GateSeal']);
        expect(result).toEqual(set);
    });

    it('without --yes the server\'s many-at-once refusal comes back in its words', async () => {
        mockApi({ 'POST /api/mainnet/tools/create_monitor': () => ({ status: 409, payload: { ok: false, error: 'That is up to 91 monitors, one per contract of Lido. Nothing was saved.', code: 'CONFIRM_MANY' } }) });
        await expect(monitorCommand(['add', '--group', 'Lido', '--event', 'Paused'])).rejects.toThrow(/up to 91 monitors/);
    });

    it('delete takes several ids or names, resolves them all first, and deletes nothing on a typo', async () => {
        const list = { invariants: [{ id: 'a1', name: 'Upgrade · stETH' }, { id: 'a2', name: 'Upgrade · wstETH' }] };
        const calls = mockApi({ 'GET /api/mainnet/invariants': () => ({ payload: list }), 'DELETE /api/mainnet/invariants/a1': () => ({ payload: { ok: true } }), 'DELETE /api/mainnet/invariants/a2': () => ({ payload: { ok: true } }) });
        const r: any = await monitorCommand(['delete', 'a1', 'Upgrade · wstETH']);
        expect(r.ids).toEqual(['a1', 'a2']);
        expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/api/mainnet/invariants/a1', '/api/mainnet/invariants/a2']);
        const again = mockApi({ 'GET /api/mainnet/invariants': () => ({ payload: list }) });
        await expect(monitorCommand(['delete', 'a1', 'nope'])).rejects.toThrow(/No monitor matches "nope".*Nothing was deleted/);
        expect(again.filter((c) => c.method === 'DELETE')).toEqual([]);
    });
});


describe('monitor add: several events, dollars', () => {
    useEnvAuth();
    const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 7 } });

    it('several --event make one monitor set each, side by side, one line each; a failed one does not stop the rest', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/create_monitor': (c) =>
                c.body.input.event === 'Nope'
                    ? { status: 404, payload: { ok: false, error: 'No contract in Lido can take this monitor.', code: 'NONE_FIT' } }
                    : ok({ monitors: 2, sentence: `${c.body.input.event} is emitted`, created: [{ id: 'a', name: 'x', contract: 'A' }, { id: 'b', name: 'y', contract: 'B' }], failed: [], skippedCount: 5, skipped: [] }),
        });
        const out: any = await monitorCommand(['add', '--group', 'Lido', '--event', 'Upgraded', '--event', 'Paused', '--event', 'Nope', '--name', 'Control']);
        expect(calls.map((c) => c.body.input.event).sort()).toEqual(['Nope', 'Paused', 'Upgraded']);
        expect(calls.find((c) => c.body.input.event === 'Paused')!.body.input).toEqual({ mode: 'event', group: 'Lido', event: 'Paused', name: 'Control · Paused', confirmMany: true });
        expect(printed()).toEqual(['Upgraded: 2 monitors · left out 5', 'Paused: 2 monitors · left out 5', 'Nope: not created — No contract in Lido can take this monitor.']);
        expect(out).toHaveLength(3);
    });

    it('a dollar line is a usd() formula in --when, sent as written', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/create_monitor': () => ok({ monitor: { id: 'm1', name: 'Big swaps' }, sentence: 'Swap worth more than $1,000,000', backtest: null }) });
        await monitorCommand(['add', '--on', 'pool', '--event', 'Swap', '--when', 'usd(abs(amount0), token0()) > 1000000', '--name', 'Big swaps']);
        expect(calls[0].body.input).toEqual({ mode: 'event', contract: 'pool', event: 'Swap', when: 'usd(abs(amount0), token0()) > 1000000', name: 'Big swaps' });
    });
});

describe('--when, one formula', () => {
    useEnvAuth();

    it('a tracked value with --when goes to add_value_monitor; a bare --warn number is refused', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/add_value_monitor': () => ({ payload: { ok: true, result: { monitor: { id: 'm1', name: 'Treasury', rule: 'treasury >= 25000' } }, ms: 40 } }) });
        await monitorCommand(['add', 'Treasury', '--when', 'value < 25000', '--warn', 'value < 30000', '--to', '#alerts']);
        expect(calls[0].body.input).toEqual({ value: 'Treasury', when: 'value < 25000', warn: 'value < 30000', to: ['#alerts'] });
        await expect(monitorCommand(['add', 'Treasury', '--when', 'value < 25000', '--warn', '30000'])).rejects.toThrow('--warn is a formula: --warn "value < 30000".');
    });
});
