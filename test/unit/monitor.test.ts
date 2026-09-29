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

    const base = {
        'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: metrics } }),
        'GET /api/cli/alert-channels': () => ({ payload: { channels } }),
    };

    it('--below builds the floor + warning tiers, binds the metric by its label alias, resolves --to by kind', async () => {
        const calls = mockApi({ ...base, 'POST /api/mainnet/invariants': (c) => ({ status: 201, payload: { invariant: invariant(c.body) } }) });
        await monitorCommand(['add', 'Treasury · Native balance', '--below', '25000', '--warn', '30000', '--to', 'telegram', '--max-age', '900']);
        const post = calls.find((c) => c.method === 'POST')!;
        expect(post.body).toEqual({
            name: 'Treasury · Native balance',
            exprAst: { type: 'cmp', op: 'gte', lhs: { type: 'ref', alias: 'treasury_native_balance' }, rhs: { type: 'lit', num: '25000', den: '1' } },
            warnExprAst: { type: 'cmp', op: 'gte', lhs: { type: 'ref', alias: 'treasury_native_balance' }, rhs: { type: 'lit', num: '30000', den: '1' } },
            inputs: [{ alias: 'treasury_native_balance', trackedOnchainValueId: 'm1' }],
            notifyAll: false,
            channelIds: ['ch1'],
            maxInputAgeSec: 900,
        });
        expect(printed()[0]).toMatch(/Created monitor "Treasury · Native balance" \(inv1\): treasury_native_balance >= 25000, warn at/);
    });

    it('--above-metric compares two metrics; --warn-pct scales the rhs; the name says "vs"', async () => {
        const calls = mockApi({ ...base, 'POST /api/mainnet/invariants': (c) => ({ status: 201, payload: { invariant: invariant(c.body) } }) });
        await monitorCommand(['add', 'm3', '--above-metric', 'Vault reserves', '--warn-pct', '5', '--to', '#alerts,ch1', '--name', 'Solvency']);
        const post = calls.find((c) => c.method === 'POST')!;
        expect(post.body.name).toBe('Solvency');
        expect(post.body.exprAst).toEqual({ type: 'cmp', op: 'lte', lhs: { type: 'ref', alias: 'vault_liabilities' }, rhs: { type: 'ref', alias: 'vault_reserves' } });
        expect(post.body.warnExprAst.rhs).toEqual({ type: 'ref', alias: 'vault_reserves', scale: { num: '95', den: '100' } });
        expect(post.body.inputs).toEqual([
            { alias: 'vault_liabilities', trackedOnchainValueId: 'm3' },
            { alias: 'vault_reserves', trackedOnchainValueId: 'm2' },
        ]);
        expect(post.body.channelIds).toEqual(['ch2', 'ch1']);
    });

    it('a default name for a comparison reads "a vs b"', async () => {
        const calls = mockApi({ ...base, 'POST /api/mainnet/invariants': (c) => ({ status: 201, payload: { invariant: invariant(c.body) } }) });
        await monitorCommand(['add', 'm2', '--below-metric', 'm3', '--to', 'ch1']);
        expect(calls.find((c) => c.method === 'POST')!.body.name).toBe('Vault reserves vs Vault liabilities');
    });

    it('refuses: no rule, two rules, no --to, warn of the wrong shape, self-comparison', async () => {
        mockApi(base);
        await expect(monitorCommand(['add', 'm1', '--to', 'ch1'])).rejects.toThrow(/needs a rule/);
        await expect(monitorCommand(['add', 'm1', '--below', '1', '--above', '2', '--to', 'ch1'])).rejects.toThrow(/Pick one rule/);
        await expect(monitorCommand(['add', 'm1', '--below', '1'])).rejects.toThrow(/--to/);
        await expect(monitorCommand(['add', 'm1', '--below', '1', '--warn-pct', '5', '--to', 'ch1'])).rejects.toThrow(/--warn-pct is for/);
        await expect(monitorCommand(['add', 'm2', '--below-metric', 'm3', '--warn', '5', '--to', 'ch1'])).rejects.toThrow(/--warn is for/);
        await expect(monitorCommand(['add', 'm2', '--below-metric', 'm2', '--to', 'ch1'])).rejects.toThrow(/against itself/);
        await expect(monitorCommand(['add', 'm1', '--below', '1', '--to', 'ch1', '--max-age', '5'])).rejects.toThrow(/at least 30/);
    });

    it('surfaces the server error (e.g. plan cap) verbatim', async () => {
        mockApi({ ...base, 'POST /api/mainnet/invariants': () => ({ status: 403, payload: { error: 'This workspace is on Free and has used all 3 of its monitors.' } }) });
        await expect(monitorCommand(['add', 'm1', '--below', '1', '--to', 'ch1'])).rejects.toThrow(/used all 3 of its monitors/);
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

    it('set rebuilds the rule on the existing subject and can swap destinations', async () => {
        const calls = mockApi({
            ...list,
            'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: metrics } }),
            'GET /api/cli/alert-channels': () => ({ payload: { channels } }),
            'PATCH /api/mainnet/invariants/inv1': (c) => ({ payload: { invariant: { ...existing, ...c.body, exprText: 'treasury_native_balance >= 20000' } } }),
        });
        await monitorCommand(['set', 'inv1', '--below', '20000', '--to', '#ops']);
        const patch = calls.find((c) => c.method === 'PATCH')!;
        expect(patch.body).toEqual({
            exprAst: { type: 'cmp', op: 'gte', lhs: { type: 'ref', alias: 'treasury_native_balance' }, rhs: { type: 'lit', num: '20000', den: '1' } },
            inputs: [{ alias: 'treasury_native_balance', trackedOnchainValueId: 'm1' }],
            warnExprAst: null,
            channelIds: ['ch3'],
        });
    });

    it('set --warn alone adds a warning tier against the existing rule; --no-warn clears it', async () => {
        const calls = mockApi({ ...list, 'PATCH /api/mainnet/invariants/inv1': (c) => ({ payload: { invariant: { ...existing, ...c.body } } }) });
        await monitorCommand(['set', 'inv1', '--warn', '30000']);
        await monitorCommand(['set', 'inv1', '--no-warn', '--no-max-age']);
        expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
            { warnExprAst: { type: 'cmp', op: 'gte', lhs: { type: 'ref', alias: 'treasury_native_balance' }, rhs: { type: 'lit', num: '30000', den: '1' } } },
            { warnExprAst: null, maxInputAgeSec: null },
        ]);
        await expect(monitorCommand(['set', 'inv1'])).rejects.toThrow(/Nothing to change/);
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
