import { monitorCommand, monitorsCommand, channelsCommand, resolveChannelIds, findChannel } from '../../src/cli/commands/monitor';
import { mockApi, useEnvAuth, printed } from './_mockApi';

const VAULT = '0x1111111111111111111111111111111111111111';

const metrics = [
    { id: 'm1', chainId: 1, address: VAULT, kind: 'nativeBalance', label: 'Treasury · Native balance', params: null, enabled: true, lastValue: 30000 },
    { id: 'm2', chainId: 1, address: VAULT, kind: 'functionResult', label: 'Vault reserves', params: null, enabled: true, lastValue: 100 },
    { id: 'm3', chainId: 1, address: VAULT, kind: 'functionResult', label: 'Vault liabilities', params: null, enabled: true, lastValue: 90 },
];
const channels = [
    { id: 'ch1', kind: 'telegram', enabled: true, label: null, target: '-100123' },
    { id: 'ch2', kind: 'discord_bot', enabled: true, label: '#alerts', target: 'Acme' },
    { id: 'ch3', kind: 'discord_bot', enabled: true, label: '#ops', target: 'Acme' },
];
const invariant = (body: any, id = 'inv1') => ({
    id,
    name: body.name ?? 'Treasury · Native balance',
    exprAst: body.exprAst,
    exprText: 'treasury_native_balance >= 25000',
    warnExprAst: body.warnExprAst ?? null,
    warnExprText: body.warnExprAst ? 'treasury_native_balance >= 30000' : null,
    enabled: true,
    status: 'warming',
    channelIds: body.channelIds ?? [],
    inputs: (body.inputs ?? []).map((i: any) => ({ ...i, trackedOnchainValue: metrics.find((m) => m.id === i.trackedOnchainValueId) })),
    snoozedUntil: body.snoozedUntil ?? null,
    maxInputAgeSec: body.maxInputAgeSec ?? null,
    notifyAll: false,
});

describe('monitor add', () => {
    useEnvAuth();

    const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 7 } });
    const made = { monitor: { id: 'inv1', name: 'Treasury · Native balance', rule: 'treasury_native_balance >= 25000', warn: 'treasury_native_balance >= 30000' } };

    it('--when and --warn go to add_value_monitor as formulas, with --to, --name and --max-age', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/add_value_monitor': () => ok(made) });
        await monitorCommand(['add', 'Treasury · Native balance', '--when', 'value < 25000', '--warn', 'value < 30000', '--to', 'telegram,#alerts', '--name', 'Floor', '--max-age', '900']);
        expect(calls.map((c) => c.path)).toEqual(['/api/mainnet/tools/add_value_monitor']);
        expect(calls[0].body.input).toEqual({ value: 'Treasury · Native balance', when: 'value < 25000', warn: 'value < 30000', to: ['telegram', '#alerts'], name: 'Floor', maxAgeSec: 900 });
        expect(printed()[0]).toBe('Created monitor "Treasury · Native balance" (inv1): treasury_native_balance >= 25000, warn at treasury_native_balance >= 30000');
    });

    it('another value, the previous reading and a reading a while ago are formulas too', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/add_value_monitor': () => ok(made) });
        await monitorCommand(['add', 'm3', '--when', 'value > {Vault reserves}', '--warn', 'value > {Vault reserves} * 0.95']);
        await monitorCommand(['add', 'm2', '--when', 'value < previous * 0.99']);
        await monitorCommand(['add', 'm2', '--when', 'value < ago(24h) * 0.8']);
        expect(calls.map((c) => c.body.input)).toEqual([
            { value: 'm3', when: 'value > {Vault reserves}', warn: 'value > {Vault reserves} * 0.95' },
            { value: 'm2', when: 'value < previous * 0.99' },
            { value: 'm2', when: 'value < ago(24h) * 0.8' },
        ]);
    });

    it('refuses before calling: no --when, a bare number, an empty --to, a short --max-age, a flag it does not take', async () => {
        const calls = mockApi({});
        await expect(monitorCommand(['add', 'm1', '--to', 'ch1'])).rejects.toThrow(/needs its rule: --when "value < 25000"/);
        await expect(monitorCommand(['add', 'm1', '--when', '25000'])).rejects.toThrow('--when is a formula: --when "value < 25000".');
        await expect(monitorCommand(['add', 'm1', '--when', 'value < 1', '--warn', '30,000'])).rejects.toThrow('--warn is a formula: --warn "value < 30000".');
        await expect(monitorCommand(['add', 'm1', '--when', 'value < 1', '--to'])).rejects.toThrow(/--to needs a destination/);
        await expect(monitorCommand(['add', 'm1', '--when', 'value < 1', '--max-age', '5'])).rejects.toThrow(/at least 30/);
        await expect(monitorCommand(['add', 'm1', '--below', '25000'])).rejects.toThrow('Unknown flag --below for monitor add. It takes --when, --warn, --to, --name, --max-age.');
        await expect(monitorCommand(['add', 'm1', '--when', 'value < 1', '--warn-pct', '5'])).rejects.toThrow(/^Unknown flag --warn-pct for monitor add\./);
        expect(calls).toHaveLength(0);
    });

    it('surfaces the server error (e.g. plan cap) verbatim', async () => {
        mockApi({ 'POST /api/mainnet/tools/add_value_monitor': () => ({ status: 403, payload: { ok: false, error: 'This workspace is on Free and has used all 3 of its monitors.', code: 'UPGRADE_REQUIRED' } }) });
        await expect(monitorCommand(['add', 'm1', '--when', 'value < 1'])).rejects.toThrow(/used all 3 of its monitors/);
    });
});

describe('channels / --to resolution', () => {
    useEnvAuth();

    it('matches id, label (with or without #), target, or a unique kind', () => {
        expect(resolveChannelIds(channels, ['ch1'])).toEqual(['ch1']);
        expect(resolveChannelIds(channels, ['alerts', '#OPS'])).toEqual(['ch2', 'ch3']);
        expect(resolveChannelIds(channels, ['-100123'])).toEqual(['ch1']);
        expect(resolveChannelIds(channels, ['telegram', 'telegram'])).toEqual(['ch1']); // deduped
        expect(() => resolveChannelIds(channels, ['discord'])).toThrow(/2 discord destinations — name one by label: #alerts, #ops/);
        expect(() => resolveChannelIds(channels, ['slack'])).toThrow(/No alert destination matches "slack"/);
        expect(() => resolveChannelIds(channels, [''])).toThrow(/at least one destination/);
    });

    it('disabled destinations are not offered, and say so when named', () => {
        const withDisabled = [...channels, { id: 'ch4', kind: 'slack', enabled: false, label: '#slack-ops', target: 'Acme' }];
        expect(() => resolveChannelIds(withDisabled, ['#slack-ops'])).toThrow(/disabled destination/);
        expect(() => resolveChannelIds(withDisabled, ['slack'])).toThrow(/No alert destination matches "slack"/);
    });

    it('channels lists the workspace destinations', async () => {
        mockApi({ 'GET /api/cli/alert-channels': () => ({ payload: { channels } }) });
        await channelsCommand();
        expect(printed()).toHaveLength(3);
        expect(printed()[1]).toMatch(/^ch2 {2}discord_bot {2}#alerts/);
    });
});

describe('monitors / monitor show / set / lifecycle', () => {
    useEnvAuth();

    const existing = invariant(
        {
            name: 'Treasury · Native balance',
            exprAst: { type: 'cmp', op: 'gte', lhs: { type: 'ref', alias: 'treasury_native_balance' }, rhs: { type: 'lit', num: '25000', den: '1' } },
            inputs: [{ alias: 'treasury_native_balance', trackedOnchainValueId: 'm1' }],
            channelIds: ['ch1'],
        },
        'inv1',
    );
    const list = { 'GET /api/mainnet/invariants': () => ({ payload: { invariants: [{ ...existing, openIncident: { id: 'inc1', openedAt: '2026-09-16T10:00:00Z', level: 'alert', peakLevel: 'alert' }, incidents30d: 1 }] } }) };

    it('monitors prints status, rule and the open episode', async () => {
        mockApi(list);
        await monitorsCommand();
        expect(printed()[0]).toMatch(/^warming {3}inv1 {2}Treasury · Native balance {2}— {2}treasury_native_balance >= 25000 {2}OPEN alert since 2026-09-16T10:00:00Z$/);
    });

    it('show resolves by name and prints inputs with live values, destinations, episodes', async () => {
        mockApi({
            ...list,
            'GET /api/mainnet/invariants/inv1': () => ({
                payload: { invariant: { ...existing, incidents: [{ id: 'inc1', openedAt: '2026-09-16T10:00:00Z', resolvedAt: null, level: 'alert', peakLevel: 'alert', ackedAt: null }] } },
            }),
            'GET /api/cli/alert-channels': () => ({ payload: { channels } }),
        });
        await monitorCommand(['show', 'treasury · native balance']);
        const out = printed().join('\n');
        expect(out).toMatch(/treasury_native_balance\s+=\s+30,000\s+Treasury · Native balance \(chain 1, 0x1111…1111, m1\)/);
        expect(out).toMatch(/sends to: telegram -100123/);
        expect(out).toMatch(/inc1 {2}alert {3}opened 2026-09-16T10:00:00Z {2}OPEN/);
    });

    const ruled = (rule: string, warn?: string) => ({ payload: { ok: true, result: { monitor: { id: 'inv1', name: 'Treasury · Native balance', rule, ...(warn ? { warn } : {}) } }, ms: 5 } });

    it('set --when changes the rule through set_value_monitor; --to still patches the destinations', async () => {
        const calls = mockApi({
            ...list,
            'GET /api/cli/alert-channels': () => ({ payload: { channels } }),
            'POST /api/mainnet/tools/set_value_monitor': () => ruled('treasury_native_balance >= 20000'),
            'PATCH /api/mainnet/invariants/inv1': (c) => ({ payload: { invariant: { ...existing, ...c.body, exprText: 'treasury_native_balance >= 20000' } } }),
        });
        await monitorCommand(['set', 'Treasury · Native balance', '--when', 'value < 20000', '--to', '#ops']);
        expect(calls.filter((c) => c.method !== 'GET').map((c) => [c.path, c.body])).toEqual([
            ['/api/mainnet/tools/set_value_monitor', { input: { monitor: 'inv1', when: 'value < 20000' } }],
            ['/api/mainnet/invariants/inv1', { channelIds: ['ch3'] }],
        ]);
        expect(printed().at(-1)).toBe('Updated "Treasury · Native balance": treasury_native_balance >= 20000');
    });

    it('set --warn alone sets the warning tier; --no-warn drops it; nothing to change, a bare number or another flag is refused', async () => {
        const calls = mockApi({
            ...list,
            'POST /api/mainnet/tools/set_value_monitor': (c) => (c.body.input.warn ? ruled('treasury_native_balance >= 25000', 'treasury_native_balance >= 30000') : ruled('treasury_native_balance >= 25000')),
            'PATCH /api/mainnet/invariants/inv1': (c) => ({ payload: { invariant: { ...existing, ...c.body } } }),
        });
        await monitorCommand(['set', 'inv1', '--warn', 'value < 30000']);
        expect(printed().at(-1)).toBe('Updated "Treasury · Native balance": treasury_native_balance >= 25000, warn at treasury_native_balance >= 30000');
        await monitorCommand(['set', 'inv1', '--no-warn', '--no-max-age']);
        expect(calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.body])).toEqual([
            ['POST', { input: { monitor: 'inv1', warn: 'value < 30000' } }],
            ['POST', { input: { monitor: 'inv1', noWarn: true } }],
            ['PATCH', { maxInputAgeSec: null }],
        ]);
        await expect(monitorCommand(['set', 'inv1'])).rejects.toThrow(/Nothing to change/);
        await expect(monitorCommand(['set', 'inv1', '--warn', '30000'])).rejects.toThrow('--warn is a formula: --warn "value < 30000".');
        await expect(monitorCommand(['set', 'inv1', '--below', '20000'])).rejects.toThrow('Unknown flag --below for monitor set. It takes --when, --warn, --no-warn, --to, --max-age, --no-max-age, --name.');
        expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(3);
    });

    it('rename / pause / resume / snooze / unsnooze / delete', async () => {
        const calls = mockApi({
            ...list,
            'PATCH /api/mainnet/invariants/inv1': (c) => ({ payload: { invariant: { ...existing, ...c.body } } }),
            'DELETE /api/mainnet/invariants/inv1': () => ({ payload: { ok: true } }),
        });
        await monitorCommand(['rename', 'inv1', 'Treasury', 'floor']);
        await monitorCommand(['pause', 'inv1']);
        await monitorCommand(['resume', 'inv1']);
        await monitorCommand(['snooze', 'inv1', '2h']);
        await monitorCommand(['unsnooze', 'inv1']);
        await monitorCommand(['delete', 'inv1']);
        const writes = calls.filter((c) => c.method !== 'GET');
        expect(writes.map((c) => c.method)).toEqual(['PATCH', 'PATCH', 'PATCH', 'PATCH', 'PATCH', 'DELETE']);
        expect(writes[0].body).toEqual({ name: 'Treasury floor' });
        expect(writes[1].body).toEqual({ enabled: false });
        expect(writes[2].body).toEqual({ enabled: true });
        expect(new Date(writes[3].body.snoozedUntil).getTime()).toBeGreaterThan(Date.now() + 119 * 60_000);
        expect(writes[4].body).toEqual({ snoozedUntil: null });
        await expect(monitorCommand(['snooze', 'inv1', '2020-01-01'])).rejects.toThrow(/in the future/);
    });
});

describe('default monitors and destinations', () => {
    useEnvAuth();

    const CONTRACT = '0x4444444444444444444444444444444444444444';
    const builtin = {
        id: 'b1', kind: 'revertRate', name: 'Revert spike', exprAst: { type: 'builtin', kind: 'revertRate' }, exprText: 'The share of transactions…', warnExprAst: null, warnExprText: null,
        enabled: true, status: 'healthy', channelIds: [], inputs: [], snoozedUntil: null, maxInputAgeSec: null, notifyAll: true,
        params: { excluded: ['1:0x5555555555555555555555555555555555555555'] },
        subjects: [{ chainId: 1, address: CONTRACT, state: 'alerting', openIncidentId: 'inc9', level: 'alert', since: '2026-09-27T09:00:00Z', sentence: 'Reverting 6.7% of transactions in the last hour' }],
    };
    const channels = [
        { id: 'ch1', kind: 'telegram', enabled: true, label: null, target: '-100123' },
        { id: 'ch2', kind: 'discord_bot', enabled: false, label: '#alerts', target: 'Acme' },
    ];

    it('exclude adds the contract to the default monitor\'s excluded list; include takes it back out', async () => {
        const calls = mockApi({
            'GET /api/mainnet/invariants': () => ({ payload: { invariants: [builtin] } }),
            'PATCH /api/mainnet/invariants/b1': (c) => ({ payload: { invariant: { ...builtin, params: c.body.params } } }),
        });
        await monitorCommand(['exclude', 'revert-spike', CONTRACT, '--chain', 'ethereum']);
        expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ params: { excluded: ['1:0x5555555555555555555555555555555555555555', `1:${CONTRACT}`] } });
        expect(printed().at(-1)).toBe('Excluded 0x4444…4444 on chain 1 from Revert spike.');

        await monitorCommand(['include', 'Revert spike', '0x5555555555555555555555555555555555555555']);
        expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body).toEqual({ params: { excluded: [] } });
    });

    it('exclude refuses a custom monitor and reports an already-excluded contract without a write', async () => {
        const rule = { ...builtin, id: 'r1', kind: null, name: 'Floor', params: null, subjects: undefined };
        const calls = mockApi({ 'GET /api/mainnet/invariants': () => ({ payload: { invariants: [builtin, rule] } }) });
        await expect(monitorCommand(['exclude', 'Floor', CONTRACT])).rejects.toThrow(/custom monitor/);
        await monitorCommand(['exclude', 'revert-spike', '0x5555555555555555555555555555555555555555']);
        expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
        expect(printed().at(-1)).toMatch(/already excluded/);
    });

    it('show on a default monitor lists the contracts it covers and the excluded ones', async () => {
        mockApi({
            'GET /api/mainnet/invariants': () => ({ payload: { invariants: [builtin] } }),
            'GET /api/mainnet/invariants/b1': () => ({ payload: { invariant: { ...builtin, incidents: [] } } }),
            'GET /api/cli/alert-channels': () => ({ payload: { channels } }),
        });
        await monitorCommand(['show', 'dependency-failure'.replace('dependency-failure', 'revert-spike')]);
        const out = printed().join('\n');
        expect(out).toMatch(/sends to: every destination/);
        expect(out).toMatch(/covers: 1 contract\n {4}alerting {2}chain 1 {9}0x4444444444444444444444444444444444444444 {2}Reverting 6\.7%/);
        expect(out).toMatch(/excluded: 1:0x5555555555555555555555555555555555555555/);
    });

    it('channels test / disable / enable / remove act on one destination by id, label or kind', async () => {
        const calls = mockApi({
            'GET /api/cli/alert-channels': () => ({ payload: { channels } }),
            'POST /api/cli/alert-channels/ch1/test': () => ({ payload: { ok: true } }),
            'PATCH /api/cli/alert-channels/ch2': (c) => ({ payload: { channels: channels.map((ch) => (ch.id === 'ch2' ? { ...ch, enabled: c.body.enabled } : ch)) } }),
            'DELETE /api/cli/alert-channels/ch1': () => ({ payload: { channels: channels.slice(1) } }),
        });
        await channelsCommand(['test', 'telegram']);
        expect(printed().at(-1)).toBe('Test alert sent to telegram -100123.');
        await channelsCommand(['enable', '#alerts']);
        expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body).toEqual({ enabled: true });
        await channelsCommand(['remove', 'ch1']);
        expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/cli/alert-channels/ch1')).toBe(true);
        expect(() => findChannel(channels, 'nope')).toThrow(/No alert destination matches/);
    });
});
