import { reportCommand, matchReport, parseWeekday, scheduleWords, machineTimeZone } from '../../src/cli/commands/report';
import { run } from '../../src/cli/index';
import { fmtLocalTime } from '../../src/cli/view';
import { parseFlags, flag, flagAll } from '../../src/cli/commands/_args';
import { mockApi, useEnvAuth, printed } from './_mockApi';

const STETH = '0x1111111111111111111111111111111111111111';
const channels = [
    { id: 'ch1', kind: 'telegram', enabled: true, label: null, target: '-100123' },
    { id: 'ch2', kind: 'discord_bot', enabled: true, label: '#alerts', target: 'Acme' },
];
const metrics = [
    { id: 'm1', chainId: 1, address: STETH, kind: 'nativeBalance', label: 'Treasury · Native balance', params: null, enabled: true, lastValue: 30000 },
    { id: 'm2', chainId: 1, address: STETH, kind: 'functionResult', label: 'Vault reserves', params: null, enabled: true, lastValue: 100 },
];
const accounts = [{ id: 'a1', chainId: 1, chainIds: [1], address: STETH, accountType: 'contract', name: 'Lido: stETH' }];

const entry = (label: string, needs?: 'name' | 'id') => ({ label, unit: 'count', scopes: ['workspace', 'tag', 'contract'], ...(needs ? { needs } : {}), definition: `${label}.` });
const catalogue = {
    activeWallets: entry('Active wallets'),
    transactions: entry('Transactions'),
    revertedShare: entry('Reverted'),
    volumeInUsd: entry('Volume in'),
    volumeOutUsd: entry('Volume out'),
    tvlUsd: entry('TVL'),
    eventCount: entry('Event', 'name'),
    trackedMetric: entry('Tracked metric', 'id'),
    customMetric: entry('Event or item metric', 'id'),
    alertsOpened: entry('Alerts opened'),
};
const dailyRows = [{ kind: 'activeWallets' }, { kind: 'transactions' }, { kind: 'revertedShare' }, { kind: 'volumeInUsd' }, { kind: 'volumeOutUsd' }, { kind: 'tvlUsd' }];
const templates = { daily: { name: 'Daily report', rows: dailyRows }, weekly: { name: 'Weekly report', rows: [...dailyRows, { kind: 'alertsOpened' }] } };
const quota = { plan: 'team', used: 1, limit: 10, columns: 'full' };

const report = (over: Record<string, unknown> = {}) => ({
    id: 'rep1',
    name: 'Daily report',
    enabled: true,
    scope: { kind: 'workspace' },
    cadence: 'daily',
    weekday: null,
    hour: 9,
    timezone: 'Australia/Sydney',
    rows: dailyRows,
    origin: 'cli',
    nextRunAt: '2026-10-13T22:00:00.000Z',
    lastRunAt: '2026-10-12T22:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    channels: [channels[1], channels[0]],
    lastRun: { id: 'run1', status: 'sent', periodKey: '2026-10-13', trigger: 'scheduled', finishedAt: '2026-10-12T22:00:04.000Z', createdAt: '2026-10-12T22:00:00.000Z' },
    ...over,
});
const listOf = (reports: unknown[]) => ({ 'GET /api/mainnet/reports': () => ({ payload: { reports, catalogue, templates, quota } }) });

const TEXT = ['Metric            24h       Δ       7d      30d', 'Active wallets  11,804   -5.8%   42,310  158,637', 'Transactions    53,012   +6.7%  412,640 1,803,110'].join('\n');
const sentRun = {
    id: 'run1', periodKey: '2026-10-13', trigger: 'scheduled', scheduledFor: '2026-10-12T22:00:00.000Z', startedAt: '2026-10-12T22:00:01.000Z', finishedAt: '2026-10-12T22:00:04.000Z',
    status: 'partial', error: null, table: {}, text: TEXT,
    deliveries: [
        { id: 'd1', channel: channels[1], status: 'sent', attempts: 1, lastError: null, lastAttemptAt: '2026-10-12T22:00:05.000Z', sentAt: '2026-10-12T22:00:05.000Z' },
        { id: 'd2', channel: channels[0], status: 'failed', attempts: 3, lastError: 'chat not found', lastAttemptAt: '2026-10-12T22:15:00.000Z', sentAt: null },
    ],
};

describe('report list', () => {
    useEnvAuth();

    it('prints name, scope, cadence and time, destinations, next send on this clock, last run status', async () => {
        const weekly = report({ id: 'rep2', name: 'Pools weekly', enabled: false, scope: { kind: 'tag', tag: 'pools' }, cadence: 'weekly', weekday: 5, hour: 17, timezone: 'Europe/London', channels: [channels[0]], lastRun: null });
        const perContract = report({ id: 'rep3', name: 'stETH daily', scope: { kind: 'contract', chainId: 1, address: STETH }, channels: [], lastRun: { ...report().lastRun, status: 'failed' } });
        const calls = mockApi({ ...listOf([report(), weekly, perContract]), 'GET /api/mainnet/accounts': () => ({ payload: { accounts } }) });
        const result = await reportCommand([]);
        const out = printed();
        expect(out[0]).toMatch(/^Name {2,}Scope {2,}Cadence {2,}Sends to {2,}Next send {2,}Last run$/);
        const next = fmtLocalTime(Date.parse('2026-10-13T22:00:00.000Z')).replace(/[+]/g, '\\+');
        expect(out[1]).toMatch(new RegExp(`^Daily report {2,}Workspace {2,}daily 09:00 Australia/Sydney {2,}#alerts, -100123 {2,}${next} {2,}sent$`));
        expect(out[2]).toMatch(/^Pools weekly {2,}tag:pools {2,}weekly Friday 17:00 Europe\/London {2,}-100123 {2,}paused {2,}—$/);
        expect(out[3]).toMatch(/^stETH daily {2,}Lido: stETH {2,}daily 09:00 Australia\/Sydney {2,}nobody {2,}.* {2,}failed$/);
        // the contracts are read only because a report is scoped to one; --json gets the server payload
        expect(calls.map((c) => c.path.split('?')[0])).toEqual(['/api/mainnet/reports', '/api/mainnet/accounts']);
        expect((result as any).quota).toEqual(quota);
    });

    it('says so when there are none, and `reports` is the noun', async () => {
        const calls = mockApi(listOf([]));
        await run(['reports']);
        expect(printed()[0]).toBe('No reports. Create one with `contract-dev report create --template daily --to <dest>`.');
        expect(calls.map((c) => c.path)).toEqual(['/api/mainnet/reports']);
    });
});

describe('report show', () => {
    useEnvAuth();

    it('resolves by a word of the name and prints settings, the latest table verbatim, then every run and delivery', async () => {
        mockApi({
            ...listOf([report(), report({ id: 'rep2', name: 'Weekly report', cadence: 'weekly', weekday: 1 })]),
            'GET /api/mainnet/reports/rep1': () => ({ payload: { report: report(), runs: [sentRun, { ...sentRun, id: 'run0', periodKey: 'manual-1760220000000', trigger: 'manual', scheduledFor: '2026-10-11T22:00:00.000Z', status: 'failed', error: 'compute timed out', text: null, deliveries: [] }] } }),
        });
        await reportCommand(['show', 'daily']);
        const out = printed();
        expect(out[0]).toBe('Daily report  (rep1)');
        expect(out[1]).toBe('  scope:      Workspace');
        expect(out[2]).toBe('  schedule:   daily 09:00 Australia/Sydney');
        expect(out[3]).toBe('  rows:       Active wallets · Transactions · Reverted · Volume in · Volume out · TVL');
        expect(out[4]).toBe('  sends to:   discord_bot #alerts, telegram -100123');
        expect(out[5]).toBe(`  next send:  ${fmtLocalTime(Date.parse('2026-10-13T22:00:00.000Z'))}`);
        expect(out[6]).toBe(`  last run:   ${fmtLocalTime(Date.parse('2026-10-12T22:00:00.000Z'))} · sent`);
        expect(out).toContain(TEXT);
        const joined = out.join('\n');
        expect(joined).toMatch(
            new RegExp(
                [
                    ' {2}runs: 2 \\(newest first\\)',
                    ' {4}Period {2,}Trigger {2,}Status {2,}Finished',
                    ' {4}2026-10-13 {2,}scheduled {2}partial {2}2026-10-12 22:00 UTC',
                    ' {6}sent {5}discord_bot #alerts {2}sent 2026-10-12 22:00 UTC',
                    ' {6}failed {3}telegram -100123 {2}error: chat not found {2}3 attempts',
                    ' {4}2026-10-11 22:00 UTC {2}manual {2,}failed {3}2026-10-12 22:00 UTC {2}error: compute timed out$',
                ].join('\\n'),
            ),
        );
    });

    it('a report that never ran, scoped to a contract, with a tracked metric row named by its label', async () => {
        mockApi({
            ...listOf([report({ scope: { kind: 'contract', chainId: 1, address: STETH }, rows: [{ kind: 'trackedMetric', params: { id: 'm2' } }, { kind: 'eventCount', params: { name: 'Swap' } }], lastRunAt: null, lastRun: null, enabled: false })]),
            'GET /api/mainnet/reports/rep1': (c) => ({ payload: { report: report({ scope: { kind: 'contract', chainId: 1, address: STETH }, rows: [{ kind: 'trackedMetric', params: { id: 'm2' } }, { kind: 'eventCount', params: { name: 'Swap' } }], lastRunAt: null, lastRun: null, enabled: false }), runs: [] } }),
            'GET /api/mainnet/accounts': () => ({ payload: { accounts } }),
            'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: metrics } }),
        });
        await reportCommand(['show', 'rep1']);
        const out = printed();
        expect(out[0]).toBe('Daily report  (rep1)  (paused)');
        expect(out[1]).toBe('  scope:      Lido: stETH');
        expect(out[3]).toBe('  rows:       Vault reserves · Swap');
        expect(out[5]).toBe('  next send:  paused');
        expect(out).toContain('No runs');
        expect(out.at(-1)).toBe('  runs: 0');
    });

    it('matchReport: id, then the exact name, a whole word, any part; ambiguity and misses say so', () => {
        const reports = [report(), report({ id: 'rep2', name: 'Weekly report' }), report({ id: 'rep3', name: 'Pools: swaps' })] as any[];
        expect(matchReport(reports, 'rep2').id).toBe('rep2');
        expect(matchReport(reports, 'weekly REPORT').id).toBe('rep2');
        expect(matchReport(reports, 'pools').id).toBe('rep3');
        expect(matchReport(reports, 'swap').id).toBe('rep3');
        expect(() => matchReport(reports, 'report')).toThrow(/"report" matches 2 reports — use an id: Daily report \(rep1\), Weekly report \(rep2\)/);
        expect(() => matchReport(reports, 'nope')).toThrow(/No report matches "nope"/);
    });
});

describe('report create', () => {
    useEnvAuth();

    const base = {
        ...listOf([]),
        'GET /api/cli/alert-channels': () => ({ payload: { channels } }),
        'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: metrics } }),
        'GET /api/mainnet/accounts': () => ({ payload: { accounts } }),
        'POST /api/mainnet/reports': (c: any) => ({ status: 201, payload: { report: report({ ...c.body, id: 'rep9', channels: c.body.channelIds.map((id: string) => channels.find((ch) => ch.id === id)), lastRunAt: null, lastRun: null }) } }),
    };

    it('--add-row keeps the template rows and appends an event metric, found by its name', async () => {
        const calls = mockApi({ ...base, 'GET /api/mainnet/custom-metrics': () => ({ payload: { metrics: [{ id: 'cm1', name: 'Swap fees' }, { id: 'cm2', name: 'Outstanding withdrawals' }] } }) });
        await reportCommand(['create', '--template', 'daily', '--add-row', 'customMetric:swap fees']);
        const post = calls.find((c) => c.method === 'POST')!;
        expect(post.body.rows).toEqual([...dailyRows, { kind: 'customMetric', params: { id: 'cm1' } }]);
        await expect(reportCommand(['create', '--template', 'daily', '--add-row', 'customMetric:Nope'])).rejects.toThrow(/No event or item metric is called "Nope"/);
    });

    it('--template fills the name, cadence and rows; the zone defaults to this machine; --to resolves by label', async () => {
        const calls = mockApi(base);
        const created = await reportCommand(['create', '--template', 'daily', '--to', '#alerts']);
        const post = calls.find((c) => c.method === 'POST')!;
        expect(post.body).toEqual({ name: 'Daily report', scope: { kind: 'workspace' }, cadence: 'daily', hour: 9, timezone: machineTimeZone(), rows: dailyRows, channelIds: ['ch2'], runNow: true });
        expect((created as any).id).toBe('rep9');
        const out = printed();
        expect(out[0]).toBe('Created report "Daily report" (rep9).');
        expect(out[1]).toBe('  scope:      Workspace');
        expect(out[2]).toBe(`  schedule:   daily 09:00 ${machineTimeZone()}`);
        expect(out[4]).toBe('  sends to:   discord_bot #alerts');
    });

    it('--row replaces the template rows (event by name, tracked metric by label); tag scope; --on, --at, --tz; repeated and comma --to', async () => {
        const calls = mockApi(base);
        await reportCommand(['create', '--template', 'weekly', '--name', 'Pools weekly', '--scope', 'tag:pools', '--row', 'transactions', '--row', 'eventCount:Swap', '--row', 'trackedMetric:Vault reserves', '--to', 'telegram', '--to', '#alerts,ch1', '--on', 'friday', '--at', '17', '--tz', 'Europe/London']);
        expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
            name: 'Pools weekly',
            scope: { kind: 'tag', tag: 'pools' },
            cadence: 'weekly',
            weekday: 5,
            hour: 17,
            timezone: 'Europe/London',
            rows: [{ kind: 'transactions' }, { kind: 'eventCount', params: { name: 'Swap' } }, { kind: 'trackedMetric', params: { id: 'm2' } }],
            channelIds: ['ch1', 'ch2'],
            runNow: true,
        });
        expect(printed()[2]).toBe('  schedule:   weekly Friday 17:00 Europe/London');
        expect(printed()[3]).toBe('  rows:       Transactions · Swap · Vault reserves');
    });

    it('--scope names a watched contract (by name or address, lower-cased); --on alone makes a report weekly on that day', async () => {
        const calls = mockApi(base);
        await reportCommand(['create', '--name', 'stETH', '--scope', 'steth', '--row', 'tvlUsd', '--on', '7', '--to', 'ch1']);
        expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ name: 'stETH', scope: { kind: 'contract', chainId: 1, address: STETH.toLowerCase() }, cadence: 'weekly', weekday: 7, rows: [{ kind: 'tvlUsd' }] });
        await reportCommand(['create', '--name', 'stETH', '--scope', `contract:${STETH.toUpperCase().replace('0X', '0x')}`, '--row', 'tvlUsd', '--to', 'ch1']);
        expect(calls.filter((c) => c.method === 'POST').at(-1)!.body).toMatchObject({ scope: { kind: 'contract', chainId: 1, address: STETH.toLowerCase() }, cadence: 'daily' });
    });

    it('refuses: no name or template, an unknown kind, an event without its name, a parameter where none goes, --on with a daily template, a bad hour, weekday or zone', async () => {
        const calls = mockApi(base);
        await expect(reportCommand(['create', '--row', 'transactions', '--to', 'ch1'])).rejects.toThrow(/--name, or start from --template/);
        await expect(reportCommand(['create', '--template', 'monthly', '--to', 'ch1'])).rejects.toThrow(/--template must be daily or weekly/);
        await expect(reportCommand(['create', '--name', 'x', '--row', 'swaps', '--to', 'ch1'])).rejects.toThrow(/Unknown row kind "swaps". One of: activeWallets, transactions/);
        await expect(reportCommand(['create', '--name', 'x', '--row', 'eventCount', '--to', 'ch1'])).rejects.toThrow(/eventCount names an event: --row eventCount:Swap/);
        await expect(reportCommand(['create', '--name', 'x', '--row', 'transactions:all', '--to', 'ch1'])).rejects.toThrow(/transactions takes no parameter/);
        await expect(reportCommand(['create', '--template', 'daily', '--on', 'monday', '--to', 'ch1'])).rejects.toThrow(/--on is for a weekly report/);
        await expect(reportCommand(['create', '--template', 'daily', '--at', '24', '--to', 'ch1'])).rejects.toThrow(/--at must be an hour from 0 to 23/);
        await expect(reportCommand(['create', '--template', 'weekly', '--on', 'someday', '--to', 'ch1'])).rejects.toThrow(/--on must be a weekday/);
        await expect(reportCommand(['create', '--template', 'daily', '--tz', 'Mars/Olympus', '--to', 'ch1'])).rejects.toThrow(/--tz must be an IANA zone name/);
        await expect(reportCommand(['create', '--template', 'daily', '--to', 'slack'])).rejects.toThrow(/No alert destination matches "slack"/);
        expect(calls.some((c) => c.method === 'POST')).toBe(false);
    });

    it('without --to the report is created with no destination, the destinations are never read, and it says where the table shows', async () => {
        const calls = mockApi(base);
        const created = await reportCommand(['create', '--template', 'daily']);
        const post = calls.find((c) => c.method === 'POST')!;
        expect(post.body).toEqual({ name: 'Daily report', scope: { kind: 'workspace' }, cadence: 'daily', hour: 9, timezone: machineTimeZone(), rows: dailyRows, channelIds: [], runNow: true });
        expect(calls.some((c) => c.path.startsWith('/api/cli/alert-channels'))).toBe(false);
        expect((created as any).channels).toEqual([]);
        const out = printed();
        expect(out[0]).toBe('Created report "Daily report" (rep9).');
        expect(out[4]).toBe('  sends to:   nobody');
        expect(out.slice(-2)).toEqual(["First table queued: it shows on the report's page within a minute, then the report runs on schedule.", "No destination yet: the table shows on the report's page in the app until one is linked."]);
    });

    it('surfaces the server error (the plan cap) verbatim', async () => {
        mockApi({ ...base, 'POST /api/mainnet/reports': () => ({ status: 403, payload: { error: 'This workspace is on Free and has used all 1 of its reports.', code: 'UPGRADE_REQUIRED' } }) });
        await expect(reportCommand(['create', '--template', 'daily', '--to', 'ch1'])).rejects.toThrow(/used all 1 of its reports/);
    });

    it('weekdays by name, prefix or number', () => {
        expect(parseWeekday('monday')).toBe(1);
        expect(parseWeekday('Wed')).toBe(3);
        expect(parseWeekday('sun')).toBe(7);
        expect(parseWeekday('4')).toBe(4);
        expect(() => parseWeekday('8')).toThrow(/--on must be a weekday/);
        expect(() => parseWeekday('mo')).toThrow(/--on must be a weekday/);
        expect(scheduleWords({ cadence: 'weekly', weekday: 3, hour: 7, timezone: 'UTC' })).toBe('weekly Wednesday 07:00 UTC');
        expect(scheduleWords({ cadence: 'daily', weekday: null, hour: 0, timezone: 'America/New_York' })).toBe('daily 00:00 America/New_York');
    });
});

describe('report preview / run / pause / resume / delete', () => {
    useEnvAuth();

    it('preview posts the draft without a schedule or destinations and prints the text', async () => {
        const calls = mockApi({
            ...listOf([]),
            'GET /api/mainnet/accounts': () => ({ payload: { accounts } }),
            'POST /api/mainnet/reports/preview': () => ({ payload: { table: {}, text: TEXT } }),
        });
        const result = await reportCommand(['preview', '--template', 'daily', '--scope', 'steth', '--tz', 'UTC', '--at', '7', '--to', 'ch1']);
        const post = calls.find((c) => c.method === 'POST')!;
        expect(post.body).toEqual({ name: 'Daily report', scope: { kind: 'contract', chainId: 1, address: STETH.toLowerCase() }, cadence: 'daily', timezone: 'UTC', rows: dailyRows });
        expect(printed()).toEqual([TEXT]);
        expect((result as any).text).toBe(TEXT);
        // a preview needs no name: the server names it
        await reportCommand(['preview', '--row', 'transactions', '--tz', 'UTC']);
        expect(calls.filter((c) => c.method === 'POST').at(-1)!.body).toEqual({ scope: { kind: 'workspace' }, cadence: 'daily', timezone: 'UTC', rows: [{ kind: 'transactions' }] });
    });

    it('run sends now and prints the status and the table; a run the server filed as failed is an error with its reason', async () => {
        const calls = mockApi({
            ...listOf([report()]),
            'POST /api/mainnet/reports/rep1/run': () => ({ status: 201, payload: { run: { ...sentRun, id: 'run5', status: 'rendered', deliveries: [] } } }),
        });
        await reportCommand(['run', 'Daily report']);
        expect(calls.at(-1)!.path).toBe('/api/mainnet/reports/rep1/run');
        expect(printed()[0]).toBe('Sending "Daily report" now (run run5, rendered) — its destinations get it within a minute.');
        expect(printed()).toContain(TEXT);

        mockApi({ ...listOf([report()]), 'POST /api/mainnet/reports/rep1/run': () => ({ status: 502, payload: { run: { ...sentRun, id: 'run6', status: 'failed', error: 'compute timed out', text: null } } }) });
        await expect(reportCommand(['run', 'rep1'])).rejects.toThrow(/Run run6 of "Daily report" failed: compute timed out/);
    });

    it('pause / resume patch enabled; delete removes the report and its runs', async () => {
        const calls = mockApi({
            ...listOf([report()]),
            'PATCH /api/mainnet/reports/rep1': (c) => ({ payload: { report: report({ ...c.body }) } }),
            'DELETE /api/mainnet/reports/rep1': () => ({ payload: { ok: true } }),
        });
        await reportCommand(['pause', 'rep1']);
        await reportCommand(['resume', 'daily report']);
        const deleted = await reportCommand(['delete', 'rep1']);
        const writes = calls.filter((c) => c.method !== 'GET');
        expect(writes.map((c) => [c.method, c.body])).toEqual([
            ['PATCH', { enabled: false }],
            ['PATCH', { enabled: true }],
            ['DELETE', null],
        ]);
        expect(printed()[0]).toBe('Paused "Daily report" — nothing sends until it is resumed.');
        expect(printed()[1]).toBe(`Resumed "Daily report" — next send ${fmtLocalTime(Date.parse('2026-10-13T22:00:00.000Z'))}.`);
        expect(printed()[2]).toBe('Deleted report "Daily report" (rep1) and its run history.');
        expect(deleted).toEqual({ ok: true, id: 'rep1' });
    });
});

describe('repeated flags and local time', () => {
    it('parseFlags keeps every value of a repeated flag; flag reads the last, flagAll all of them', () => {
        const flags = parseFlags(['--row', 'a', '--row=b', '--to', 'x', '--chain', '1', '--chain', '2']);
        expect(flagAll(flags, 'row')).toEqual(['a', 'b']);
        expect(flagAll(flags, 'to')).toEqual(['x']);
        expect(flagAll(flags, 'none')).toEqual([]);
        expect(flag(flags, 'row')).toBe('b');
        expect(flag(flags, 'chain')).toBe('2');
    });

    it('fmtLocalTime prints the wall time in the zone it is given, with the zone', () => {
        const ms = Date.UTC(2026, 9, 13, 22, 0);
        expect(fmtLocalTime(ms, 'UTC')).toBe('2026-10-13 22:00 UTC');
        expect(fmtLocalTime(ms, 'Australia/Sydney')).toMatch(/^2026-10-14 09:00 /);
        expect(fmtLocalTime(ms, 'America/New_York')).toBe('2026-10-13 18:00 EDT');
        expect(fmtLocalTime(null)).toBe('—');
    });

    it('report create help answers with the help, not an error', async () => {
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        await reportCommand(['create', 'help']);
        expect(String(log.mock.calls[0][0])).toMatch(/^contract-dev report — /);
        log.mockRestore();
    });
});

describe('report create / preview --each', () => {
    useEnvAuth();
    const each = { metricId: 'cm1', metricName: 'Swap size (USD)', when: 'value >= 10000', message: '{name(sender())} swapped {value}' };
    const preview = { each: { days: 7, from: '2026-10-13T12:00:00Z', looked: 1689, matches: 203, samples: [{ time: '2026-10-14T12:44:23Z', text: 'alice.eth swapped $47,241', txUrl: 'https://x/tx' }] }, note: '' };

    test('create --each posts the metric, condition and message, resolves --to, and prints how often it would have sent', async () => {
        const calls = mockApi({
            'GET /api/cli/alert-channels': () => ({ payload: { channels } }),
            'POST /api/mainnet/reports': () => ({ payload: { report: report({ id: 'rep9', name: 'Large swaps', cadence: 'each', rows: [], each, channels: [channels[1]] }) } }),
            'POST /api/mainnet/tools/preview_report': () => ({ payload: { ok: true, result: preview, ms: 5 } }),
        });
        await run(['report', 'create', '--each', '--name', 'Large swaps', '--metric', 'Swap size (USD)', '--when', 'value >= 10000', '--message', '{name(sender())} swapped {value}', '--to', '#alerts']);
        const post = calls.find((c) => c.method === 'POST' && c.path === '/api/mainnet/reports');
        expect(post?.body).toEqual({ name: 'Large swaps', cadence: 'each', metric: 'Swap size (USD)', when: 'value >= 10000', message: '{name(sender())} swapped {value}', channelIds: ['ch2'] });
        const out = printed();
        expect(out.some((l) => l.includes('each time "Swap size (USD)" has a record where value >= 10000'))).toBe(true);
        expect(out.some((l) => l.includes('It would have sent 203 messages'))).toBe(true);
        expect(out.some((l) => l.includes('alice.eth swapped $47,241'))).toBe(true);
    });

    test('preview --each asks the tool and needs every part', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/preview_report': () => ({ payload: { ok: true, result: preview, ms: 5 } }) });
        await run(['report', 'preview', '--each', '--metric', 'Swap size (USD)', '--when', 'value >= 10000', '--message', 'x {value}']);
        expect(calls[0].body).toEqual({ input: { cadence: 'each', metric: 'Swap size (USD)', when: 'value >= 10000', message: 'x {value}' } });
        await expect(run(['report', 'preview', '--each', '--metric', 'Swap size (USD)'])).rejects.toThrow(/--each needs --when, --message/);
    });
});
