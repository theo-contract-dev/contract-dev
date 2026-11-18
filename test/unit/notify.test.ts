import { alertTrigger, compareItems, matchItem, monitorArgs, monitorItem, reportArgs, reportItem, updateArgs, notifyCommand } from '../../src/cli/commands/notify';
import { run } from '../../src/cli/index';
import { mockApi, useEnvAuth, printed } from './_mockApi';

const channels = [
    { id: 'ch1', kind: 'telegram', enabled: true, label: null, target: '-100123' },
    { id: 'ch2', kind: 'slack', enabled: true, label: '#alerts', target: 'Acme' },
];

const monitor = (over: Record<string, unknown> = {}) => ({
    id: 'inv1',
    name: 'Treasury low',
    kind: null,
    exprAst: {},
    exprText: 'balance >= 25000',
    warnExprAst: null,
    warnExprText: null,
    alertsWhen: { critical: 'Below 25,000', warning: null },
    maxInputAgeSec: null,
    enabled: true,
    snoozedUntil: null,
    notifyAll: false,
    channelIds: ['ch1'],
    status: 'ok',
    statusSince: null,
    lastEvalAt: null,
    inputs: [],
    openIncident: null,
    lastIncidentAt: null,
    ...over,
});

const report = (over: Record<string, unknown> = {}) => ({
    id: 'rep1',
    name: 'Daily report',
    enabled: true,
    scope: { kind: 'workspace' },
    cadence: 'daily',
    weekday: null,
    hour: 9,
    timezone: 'UTC',
    rows: [],
    origin: 'cli',
    nextRunAt: null,
    lastRunAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    channels: [channels[1]],
    lastRun: null,
    each: null,
    ...over,
});

describe('notify: the app’s types and statuses', () => {
    test('a value monitor is an alert on a condition; Active, Alerting (a crossed warning line too), No data, Paused; nowhere to send is not a status', () => {
        expect(monitorItem(monitor() as any, channels as any)).toMatchObject({ type: 'alert', trigger: 'condition', status: 'Active', when: 'alerts when below 25,000', sendsTo: ['-100123'] });
        expect(monitorItem(monitor({ status: 'breached' }) as any, channels as any).status).toBe('Alerting');
        expect(monitorItem(monitor({ status: 'warning' }) as any, channels as any).status).toBe('Alerting');
        expect(monitorItem(monitor({ status: 'stale' }) as any, channels as any).status).toBe('No data');
        expect(monitorItem(monitor({ channelIds: [] }) as any, channels as any)).toMatchObject({ status: 'Active', sendsTo: [] });
        expect(monitorItem(monitor({ enabled: false, status: 'breached' }) as any, channels as any).status).toBe('Paused');
    });

    test('an event monitor reads as an alert on something happening: Active, never Alerting', () => {
        const item = monitorItem(monitor({ kind: 'eventFired', status: 'breached', alertsWhen: { critical: 'Emitted', warning: null } }) as any, channels as any);
        expect(item).toMatchObject({ type: 'alert', trigger: 'event', status: 'Active', when: 'Emitted' });
    });

    test('a scheduled report is a report, an each-time one an alert on something happening; Active or Paused', () => {
        expect(reportItem(report() as any)).toMatchObject({ type: 'report', status: 'Active', when: 'daily 09:00 UTC', sendsTo: ['#alerts'] });
        const each = { kind: 'event', subject: 'Swap', metricId: null, metricName: null, when: 'value >= 10000', message: 'x', digestMinutes: 60 };
        expect(reportItem(report({ cadence: 'each', each, channels: [] }) as any)).toMatchObject({ type: 'alert', trigger: 'event', status: 'Active', when: 'each Swap when value >= 10000 (digest every 1h)' });
        expect(reportItem(report({ enabled: false }) as any).status).toBe('Paused');
    });

    test('the list puts what needs a look first, then by name', () => {
        const items = [reportItem(report({ name: 'B' }) as any), monitorItem(monitor({ name: 'Z', status: 'breached' }) as any, channels as any), reportItem(report({ name: 'A', enabled: false }) as any)];
        expect(items.sort(compareItems).map((i) => i.name)).toEqual(['Z', 'B', 'A']);
    });

    test('a name resolves across both; two of a name ask for an id', () => {
        const items = [reportItem(report({ id: 'r1', name: 'Swaps' }) as any), monitorItem(monitor({ id: 'm1', name: 'swaps' }) as any, channels as any)];
        expect(matchItem(items, 'r1').type).toBe('report');
        expect(() => matchItem(items, 'Swaps')).toThrow(/2 notifications are named "Swaps" — use an id: r1 \(report\), m1 \(alert\)/);
        expect(() => matchItem(items, 'Nope')).toThrow(/No notification matches "Nope"/);
    });
});

describe('notify add: the type’s own command', () => {
    test('a report: the name becomes --name, the rest passes through; a trigger is refused toward update', () => {
        expect(reportArgs(['Hourly swaps', '--every', '1h', '--row', 'eventCount:Swap', '--to', 'telegram'])).toEqual(['create', '--name', 'Hourly swaps', '--every', '1h', '--row', 'eventCount:Swap', '--to', 'telegram']);
        expect(reportArgs(['--template', 'weekly', '--on', 'friday'])).toEqual(['create', '--template', 'weekly', '--on', 'friday']);
        expect(() => reportArgs(['x', '--on-event', 'Swap'])).toThrow(/is an alert on an event/);
    });

    test('an update: --event becomes the trigger, --on and --group the scope, --metric the each-time form; --method is refused', () => {
        expect(updateArgs(['Large swaps', '--on', 'steth', '--event', 'Swap', '--value', 'usd(amount, token)', '--when', 'value >= 10000', '--message', '{value}']))
            .toEqual(['create', '--name', 'Large swaps', '--scope', 'steth', '--on-event', 'Swap', '--value', 'usd(amount, token)', '--when', 'value >= 10000', '--message', '{value}']);
        expect(() => updateArgs(['--group', 'pools', '--method', 'pause()', '--message', 'paused'])).toThrow(/function call are not available/);
        // --call is a read everywhere else (metric define): a method called on the contract is --method
        expect(() => updateArgs(['--group', 'pools', '--call', 'pause()', '--message', 'paused'])).toThrow(/--method/);
        expect(updateArgs(['--metric', 'Swap size (USD)', '--message', 'm'])).toEqual(['create', '--each', '--metric', 'Swap size (USD)', '--message', 'm']);
        expect(() => updateArgs(['x', '--message', 'm'])).toThrow(/needs what happens/);
        expect(() => updateArgs(['x', '--on', 'steth', '--silence', '--event', 'Swap'])).toThrow(/is an alert on a condition/);
        expect(() => updateArgs(['x', '--on', 'steth', '--event', 'Swap', '--message', 'm', '--digest', '1h'])).toThrow(/once per block/);
    });

    test('a monitor: --value or a second positional is what it watches; --warn and a bare event are refused', () => {
        expect(monitorArgs(['Treasury low', '--value', 'Treasury · Native balance', '--when', 'value < 25000', '--to', 'telegram']))
            .toEqual(['add', 'Treasury · Native balance', '--when', 'value < 25000', '--to', 'telegram', '--name', 'Treasury low']);
        expect(monitorArgs(['Treasury low', 'Treasury · Native balance', '--when', 'value < 25000'])).toEqual(['add', 'Treasury · Native balance', '--when', 'value < 25000', '--name', 'Treasury low']);
        expect(monitorArgs(['stETH quiet', '--on', 'steth', '--silence', '--event', 'Transfer', '--for', '24h'])).toEqual(['add', '--on', 'steth', '--silence', '--event', 'Transfer', '--for', '24h', '--name', 'stETH quiet']);
        expect(() => monitorArgs(['x', '--value', 'v', '--when', 'value < 1', '--warn', 'value < 2'])).toThrow(/one line/);
        expect(() => monitorArgs(['x', '--on', 'steth', '--event', 'Swap'])).toThrow(/alert on something happening/);
        // notify add alert picks the trigger from the flags
        expect(alertTrigger(['x', '--on', 'steth', '--event', 'Swap', '--message', 'm'])).toBe('event');
        expect(alertTrigger(['x', '--on', 'steth', '--silence', '--event', 'Swap'])).toBe('condition');
        expect(alertTrigger(['x', '--value', 'Treasury', '--when', 'value < 1'])).toBe('condition');
        expect(alertTrigger(['x', '--on-member', 'Pools', '--message', 'm'])).toBe('event');
        expect(() => monitorArgs(['Treasury low', '--when', 'value < 1'])).toThrow(/needs what it watches/);
    });
});

describe('notify against the API', () => {
    useEnvAuth();
    const base = {
        'GET /api/mainnet/invariants': () => ({ payload: { invariants: [monitor({ status: 'breached', openIncident: { id: 'inc7', openedAt: '2026-11-06T00:00:00Z', level: 'critical', peakLevel: 'critical' } })] } }),
        'GET /api/mainnet/reports': () => ({ payload: { reports: [report()], catalogue: {}, templates: {}, quota: null } }),
        'GET /api/cli/alert-channels': () => ({ payload: { channels } }),
    };

    test('list prints both kinds with the app’s words; --type narrows', async () => {
        mockApi(base);
        const all = (await run(['notify'])) as any[];
        expect(all.map((i) => [i.type, i.name, i.status])).toEqual([['alert', 'Treasury low', 'Alerting'], ['report', 'Daily report', 'Active']]);
        expect(printed()[0]).toMatch(/^Type\s+Name\s+When\s+Status\s+Latest\s+Id$/);
        const monitors = (await notifyCommand(['list', '--type', 'alerts'])) as any[];
        expect(monitors.map((i) => i.name)).toEqual(['Treasury low']);
        await expect(notifyCommand(['list', '--type', 'monitor'])).rejects.toThrow(/--type is report or alert/);
    });

    test('ack acknowledges the open alert; run refuses a monitor and runs a report (send is its alias)', async () => {
        const calls = mockApi({
            ...base,
            'PATCH /api/mainnet/incidents/inc7': () => ({ payload: { ok: true } }),
            'POST /api/mainnet/reports/rep1/run': () => ({ payload: { run: { id: 'run1', status: 'queued', text: null } } }),
        });
        expect(await notifyCommand(['ack', 'Treasury low'])).toEqual({ id: 'inc7', acked: true });
        expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ acked: true });
        await expect(notifyCommand(['send', 'Treasury low'])).rejects.toThrow(/is an alert/);
        await notifyCommand(['run', 'Daily report']);
        expect(calls.some((c) => c.method === 'POST' && c.path === '/api/mainnet/reports/rep1/run')).toBe(true);
    });

    test('add update posts an each-time report on the group, and says it made an update', async () => {
        const calls = mockApi({
            ...base,
            'POST /api/mainnet/reports': (c: any) => ({ status: 201, payload: { report: report({ id: 'rep9', name: c.body.name, cadence: 'each', channels: [], each: { kind: 'event', subject: 'Swap', metricId: null, metricName: null, when: 'true', message: c.body.message, digestMinutes: null } }) } }),
        });
        await expect(run(['notify', 'add', 'alert', 'Swaps', '--group', 'pools', '--each', 'Swap', '--message', '{value}'])).rejects.toThrow('--group is gone: say --on tag:<group> (contract-dev notify help).');
        await expect(run(['notify', 'add', 'alert', 'Swaps', '--on', 'tag:pools', '--event', 'Swap', '--message', '{value}'])).rejects.toThrow('--event is gone: say --each <Event> (contract-dev notify help).');
        await run(['notify', 'add', 'update', 'Swaps', '--on', 'tag:pools', '--each', 'Swap', '--message', '{value}']);
        const post = calls.find((c) => c.method === 'POST' && c.path === '/api/mainnet/reports');
        expect(post?.body).toMatchObject({ name: 'Swaps', cadence: 'each', trigger: { kind: 'event', event: 'Swap' }, scope: { kind: 'tag', tag: 'pools' }, message: '{value}' });
        expect(printed()[0]).toBe('Created alert "Swaps" (rep9).');
    });
});

describe('notify: a row threshold (2026-11-08)', () => {
    useEnvAuth();
    const row = (id: string, n: string, status: string) =>
        monitor({ id, name: `Motion unopposed · Easy Track · ${n}`, status, notifyAll: true, channelIds: [], params: { tagTableId: 't1', tagTableMonitorId: 'tm1', tagTableItemId: `i${n}` }, alertsWhen: { critical: 'Objections below 1', warning: null }, lastIncidentAt: status === 'breached' ? '2026-11-08T10:00:00Z' : null });
    const base = {
        'GET /api/mainnet/invariants': () => ({ payload: { invariants: [monitor(), row('r1', '1210', 'breached'), row('r2', '1211', 'ok')] } }),
        'GET /api/mainnet/reports': () => ({ payload: { reports: [], catalogue: {}, templates: {}, quota: null } }),
        'GET /api/cli/alert-channels': () => ({ payload: { channels } }),
    };

    test('add alert --on table: sends add_table_monitor with --to; --remind is refused; set --to re-points every row', async () => {
        const calls = mockApi({ ...base, 'POST /api/mainnet/tools/add_table_monitor': () => ({ payload: { ok: true, result: { table: { id: 't1', name: 'Easy Track motions' }, monitor: { id: 'tm1', name: 'Motion unopposed', words: 'Motion unopposed: objections below 1', rows: 2 } }, ms: 9 } }) });
        await notifyCommand(['add', 'alert', 'Motion unopposed', '--on', 'table:"Easy Track motions"', '--column', 'Objections', '--when', 'value < 1']);
        expect(calls.find((c) => c.path.endsWith('add_table_monitor'))?.body).toEqual({ input: { table: 'Easy Track motions', name: 'Motion unopposed', column: 'Objections', when: 'value < 1' } });
        expect(printed()[0]).toBe('Created row threshold "Motion unopposed" (tm1) on Easy Track motions: Motion unopposed: objections below 1.');
        await notifyCommand(['add', 'alert', 'X', '--on', 'table:Loans', '--column', 'Health', '--when', 'value < 1', '--to', '#alerts']);
        expect(calls.filter((c) => c.path.endsWith('add_table_monitor'))[1]?.body.input.to).toEqual(['#alerts']);
        await expect(notifyCommand(['add', 'alert', 'X', '--on', 'table:Loans', '--column', 'Health', '--when', 'value < 1', '--remind'])).rejects.toThrow(/--remind is not taken on a row threshold/);
        await expect(notifyCommand(['add', 'alert', 'X', '--on', 'table:Loans', '--when', 'value < 1'])).rejects.toThrow(/needs the read column/);
    });

    test('its rows list as one line, Alerting while any row is; delete drops the rule and every row', async () => {
        const calls = mockApi({ ...base, 'DELETE /api/console/tables/t1/monitors': () => ({ payload: { ok: true } }) });
        const all = (await notifyCommand(['list'])) as any[];
        expect(all.map((i) => [i.name, i.status, i.source])).toEqual([['Motion unopposed', 'Alerting', 'table'], ['Treasury low', 'Active', 'monitor']]);
        expect(all[0].when).toBe('alerts when objections below 1 · 2 open rows, 1 alerting');
        await notifyCommand(['delete', 'Motion unopposed']);
        expect(calls.find((c) => c.method === 'DELETE')?.path).toBe('/api/console/tables/t1/monitors?monitorId=tm1');
    });
});

describe('notify add alert --overdue', () => {
    test('is an alert on a condition, handed to the monitor command with its flags', () => {
        const args = ['Unclaimed', '--on', 'wq', '--overdue', '--event', 'WithdrawalRequested', '--answer', 'WithdrawalClaimed', '--for', '7d'];
        expect(alertTrigger(args)).toBe('condition');
        expect(monitorArgs(args)).toEqual(['add', '--on', 'wq', '--overdue', '--event', 'WithdrawalRequested', '--answer', 'WithdrawalClaimed', '--for', '7d', '--name', 'Unclaimed']);
    });
});

describe('notify set on a row threshold', () => {
    useEnvAuth();
    test('--to re-points the rule and every row; --to none sends nowhere; anything else is refused', async () => {
        const row = monitor({ id: 'r1', name: 'Loan at risk · Pool · 7', params: { tagTableId: 't1', tagTableMonitorId: 'tm1' }, alertsWhen: { critical: 'Below 1.1', warning: null } });
        const calls = mockApi({
            'GET /api/mainnet/invariants': () => ({ payload: { invariants: [row] } }),
            'GET /api/mainnet/reports': () => ({ payload: { reports: [], catalogue: {}, templates: {}, quota: null } }),
            'GET /api/cli/alert-channels': () => ({ payload: { channels } }),
            'PATCH /api/console/tables/t1/monitors': () => ({ payload: { rows: 1 } }),
        });
        await notifyCommand(['set', 'Loan at risk', '--to', '#alerts']);
        expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ monitorId: 'tm1', channelIds: ['ch2'] });
        await notifyCommand(['set', 'Loan at risk', '--to', 'none']);
        expect(calls.filter((c) => c.method === 'PATCH')[1]?.body).toEqual({ monitorId: 'tm1', channelIds: [] });
        await expect(notifyCommand(['set', 'Loan at risk', '--when', 'value < 2'])).rejects.toThrow(/changes where it sends/);
    });
});

describe('the words an alert wears (shared with the app rail)', () => {
    const { ALERT_TYPE_WORD, eachTriggerWord, monitorTriggerWord, monitorTrigger } = require('../../src/cli/commands/_alertWords');
    test('type by trigger', () => {
        expect(ALERT_TYPE_WORD.event).toBe('Activity alert');
        expect(ALERT_TYPE_WORD.condition).toBe('Condition alert');
        expect(monitorTrigger({ kind: 'eventFired' })).toBe('event');
        expect(monitorTrigger({ kind: 'metricWindow' })).toBe('condition');
        expect(monitorTrigger({ kind: null })).toBe('condition');
    });
    test('an alert on something happening, by its trigger', () => {
        expect(eachTriggerWord({ kind: 'metricRecord' })).toBe('Event');
        expect(eachTriggerWord({ kind: 'value' })).toBe('Metric changed');
        expect(eachTriggerWord({ kind: 'row', on: 'opened' })).toBe('Row opened');
        expect(eachTriggerWord({ kind: 'row', on: 'finished' })).toBe('Row closed');
        expect(eachTriggerWord({ kind: 'row', on: 'both' })).toBe('Row opened or closed');
        expect(eachTriggerWord({ kind: 'member', on: 'joined' })).toBe('Joined group');
        expect(eachTriggerWord({ kind: 'member', on: 'left' })).toBe('Left group');
        expect(eachTriggerWord({ kind: 'call' })).toBe('Function call');
    });
    test('an alert on a condition, by its kind: one word for a threshold on any metric', () => {
        expect(monitorTriggerWord({ kind: null })).toBe('Metric threshold');
        expect(monitorTriggerWord({ kind: 'metricWindow' })).toBe('Metric threshold');
        expect(monitorTriggerWord({ kind: 'silence' })).toBe('Gone quiet');
        expect(monitorTriggerWord({ kind: 'unanswered' })).toBe('Overdue');
        expect(monitorTriggerWord({ kind: 'failures' })).toBe('Failing calls');
        expect(monitorTriggerWord({ kind: null, params: { tagTableMonitorId: 'ttm1' } })).toBe('Row threshold');
        expect(monitorTriggerWord({ kind: 'eventFired' })).toBe('Event');
    });
});
