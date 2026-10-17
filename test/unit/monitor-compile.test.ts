import { monitorCommand, parseDuration, buildIntent, backtestLines, shellQuote } from '../../src/cli/commands/monitor';
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

    it('refuses a flag an event monitor does not take before calling, naming the ones it takes', async () => {
        const calls = mockApi({});
        await expect(monitorCommand(['compile', '--on', 'steth', '--event', 'Transfer', '--where', 'value at least 1,000'])).rejects.toThrow(
            'Unknown flag --where for monitor compile. It takes --on, --group, --chain, --event, --silence, --method, --for, --when, --name, --to, --yes.',
        );
        await expect(monitorCommand(['add', '--on', 'pool', '--event', 'Swap', '--usd-above', '1000000'])).rejects.toThrow(/^Unknown flag --usd-above for monitor add\./);
        await expect(monitorCommand(['add', '--on', 'pool', '--event', 'Swap', '--event', 'Mint', '--token', 'amount0=token0()'])).rejects.toThrow(/^Unknown flag --token for monitor add\./);
        expect(calls).toHaveLength(0);
    });

    it('turns --on/--event/--when/--to/--name/--chain into the intent and prints the sentence, conditions, backtest, notes and the add line', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/compile_monitor': () => ok(compiled) });
        const when = `amount(value, emitter()) >= 1000 and to != ${ZERO}`;
        const args = ['compile', '--on', 'steth', '--event', 'Transfer', '--when', when, '--to', '#alerts', '--to', 'telegram,ch1', '--name', 'Big transfers', '--chain', '1'];
        const result = await monitorCommand(args);
        expect(calls[0].path).toBe('/api/mainnet/tools/compile_monitor');
        expect(calls[0].body).toEqual({
            input: {
                mode: 'event',
                contract: 'steth',
                chainId: 1,
                event: 'Transfer',
                when,
                name: 'Big transfers',
                destinations: ['#alerts', 'telegram', 'ch1'],
            },
        });
        expect(printed()).toEqual([
            'Big transfers: Transfer is emitted where value is at least 1,000 stETH and to is not 0x0000…0000',
            '  name:        Big transfers',
            `  on:          Lido: stETH (Ethereum ${STETH})`,
            `  conditions:  value at least 1,000 stETH · to is not ${ZERO}`,
            '  sends to:    #alerts, telegram, ch1',
            '  backtest:    Would have fired 12 times in 7 days',
            `    2026-10-12 03:19 UTC  0xd6ad…cfac  from=0x1111…1111 to=0x2222…2222 value=1,500 stETH  ${TX('a')}`,
            `    2026-10-11 22:00 UTC  0xd6ad…cfac  from=0x1111…1111 to=0x2222…2222 value=2,000 stETH  ${TX('b')}`,
            `    2026-10-10 09:45 UTC  0xd6ad…cfac  from=0x1111…1111 to=0x2222…2222 value=1,001 stETH  ${TX('c')}`,
            '  note: value: compared in base units (no token unit could be resolved for this field).',
            `Save it with: contract-dev monitor add --on steth --event Transfer --when "${when}" --to "#alerts" --to telegram,ch1 --name "Big transfers" --chain 1`,
        ]);
        expect(result).toEqual(compiled);
    });

    it('--silence with --method and --for compiles a silence monitor; the backtest says how often it was seen; no destinations pages nobody', async () => {
        const silence = {
            ...compiled,
            name: 'No submit on Lido: stETH',
            sentence: 'submit has not been seen for 90 minutes',
            conditions: [],
            channelIds: [],
            backtest: { window: '7d', occurrences: 42, lastSeenAt: '2026-10-12T03:19:00.000Z' },
            notes: ['No destinations named: the monitor will record alerts on its page and page nobody.'],
        };
        const calls = mockApi({ 'POST /api/mainnet/tools/compile_monitor': () => ok(silence) });
        await run(['monitor', 'compile', '--on', STETH, '--silence', '--method', 'submit', '--for', '90m']);
        expect(calls[0].body).toEqual({ input: { mode: 'silence', contract: STETH, method: 'submit', windowSec: 5400 } });
        const out = printed();
        expect(out[0]).toBe('submit has not been seen for 90 minutes');
        expect(out[3]).toBe('  conditions:  none');
        expect(out[4]).toBe('  sends to:    nobody');
        expect(out[5]).toBe('  backtest:    Seen 42 times in 7 days, last 2026-10-12 03:19 UTC');
        expect(out[6]).toBe('  note: No destinations named: the monitor will record alerts on its page and page nobody.');
        expect(out[7]).toBe(`Save it with: contract-dev monitor add --on ${STETH} --silence --method submit --for 90m`);
    });

    it('--silence --event watches an event going quiet; a missing backtest says so; a silence never seen has no last time', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/compile_monitor': (c) => ok({ ...compiled, conditions: [], backtest: c.body.input.windowSec === 259_200 ? null : { window: '7d', occurrences: 0, lastSeenAt: null } }) });
        await monitorCommand(['compile', '--on', 'steth', '--silence', '--event', 'Submitted', '--for', '3d']);
        expect(calls[0].body).toEqual({ input: { mode: 'silence', contract: 'steth', event: 'Submitted', windowSec: 259_200 } });
        expect(printed()[5]).toBe('  backtest:    unavailable');
        await monitorCommand(['compile', '--on', 'steth', '--silence', '--for', '24h']);
        expect(calls[1].body).toEqual({ input: { mode: 'silence', contract: 'steth', windowSec: 86_400 } });
        expect(printed().slice(8)[5]).toBe('  backtest:    Seen 0 times in 7 days');
    });

    it("surfaces the compiler's refusal verbatim, and refuses the flag mixes it cannot mean before calling", async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/compile_monitor': () => ({ status: 400, payload: { ok: false, error: 'Transfer has no comparable field "amount". Its fields: from (address), to (address), value (uint256).', code: 'NO_FIELD' } }),
        });
        await expect(monitorCommand(['compile', '--on', 'steth', '--event', 'Transfer', '--when', 'amount > 5'])).rejects.toThrow('Transfer has no comparable field "amount". Its fields: from (address), to (address), value (uint256).');
        expect(calls).toHaveLength(1);
        await expect(monitorCommand(['compile', '--event', 'Transfer'])).rejects.toThrow(/Say where: --on <contract>/);
        await expect(monitorCommand(['compile', '--on', 'steth', '--group', 'Lido', '--event', 'Transfer'])).rejects.toThrow(/not both/);
        await expect(monitorCommand(['compile', '--on', 'steth'])).rejects.toThrow(/Say what to watch: --event <Name>/);
        await expect(monitorCommand(['compile', '--on', 'steth', '--event', 'Transfer', '--method', 'submit'])).rejects.toThrow(/--method is for a silence monitor/);
        await expect(monitorCommand(['compile', '--on', 'steth', '--event', 'Transfer', '--for', '1h'])).rejects.toThrow(/--for is for a silence monitor/);
        await expect(monitorCommand(['compile', '--on', 'steth', '--silence', '--when', 'value > 5'])).rejects.toThrow(/--when is for an event monitor/);
        await expect(monitorCommand(['compile', '--on', 'steth', '--silence', '--event', 'Transfer', '--method', 'submit'])).rejects.toThrow(/an event or a method, not both/);
        await expect(monitorCommand(['compile', '--on', 'steth', '--event'])).rejects.toThrow(/--event needs the event's name/);
        await expect(monitorCommand(['compile', '--on', 'steth', '--event', 'Transfer', '--when'])).rejects.toThrow(/--when needs the formula/);
        expect(calls).toHaveLength(1);
    });

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

    it('buildIntent carries only what was given; backtestLines caps the firings at three; shellQuote quotes what needs it', () => {
        expect(buildIntent(parseFlags(['--on', 'steth', '--event', 'Transfer']))).toEqual({ mode: 'event', contract: 'steth', event: 'Transfer' });
        expect(buildIntent(parseFlags(['--on', 'steth', '--silence', '--to', 'ch1', '--name', ' Quiet ']))).toEqual({ mode: 'silence', contract: 'steth', name: 'Quiet', destinations: ['ch1'] });
        const many = { window: '7d', matches: 1, recent: [firing('a', '2026-10-12T03:19:00.000Z', '1'), firing('b', '2026-10-12T03:19:00.000Z', '2'), firing('c', '2026-10-12T03:19:00.000Z', '3'), firing('d', '2026-10-12T03:19:00.000Z', '4')] };
        expect(backtestLines(many)).toHaveLength(4);
        expect(backtestLines(many)[0]).toBe('  backtest:    Would have fired 1 time in 7 days');
        expect(backtestLines({ window: '7d', matches: 0, recent: [] })).toEqual(['  backtest:    Would have fired 0 times in 7 days']);
        expect(backtestLines(null)).toEqual(['  backtest:    unavailable']);
        expect(shellQuote('steth')).toBe('steth');
        expect(shellQuote('telegram,ch1')).toBe('telegram,ch1');
        expect(shellQuote('#alerts')).toBe('"#alerts"');
        expect(shellQuote('value at least 1,000')).toBe('"value at least 1,000"');
        expect(shellQuote('say "hi" $now')).toBe('"say \\"hi\\" \\$now"');
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

    it('an event monitor sends its formula as when', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/compile_monitor': () => ({ payload: { ok: true, result: compiled, ms: 40 } }) });
        await monitorCommand(['compile', '--on', 'steth', '--event', 'Transfer', '--when', 'amount(value, emitter()) >= 1000']);
        expect(calls[0].body.input).toMatchObject({ mode: 'event', contract: 'steth', event: 'Transfer', when: 'amount(value, emitter()) >= 1000' });
    });

    it('a tracked value with --when goes to add_value_monitor; a bare --warn number is refused', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/add_value_monitor': () => ({ payload: { ok: true, result: { monitor: { id: 'm1', name: 'Treasury', rule: 'treasury >= 25000' } }, ms: 40 } }) });
        await monitorCommand(['add', 'Treasury', '--when', 'value < 25000', '--warn', 'value < 30000', '--to', '#alerts']);
        expect(calls[0].body.input).toEqual({ value: 'Treasury', when: 'value < 25000', warn: 'value < 30000', to: ['#alerts'] });
        await expect(monitorCommand(['add', 'Treasury', '--when', 'value < 25000', '--warn', '30000'])).rejects.toThrow('--warn is a formula: --warn "value < 30000".');
    });
});
