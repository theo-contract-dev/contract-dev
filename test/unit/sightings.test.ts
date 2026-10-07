import { run } from '../../src/cli/index';
import { quietStretches, windowWords, type SightingsPayload } from '../../src/cli/commands/monitor';
import { mockApi, useEnvAuth, printed, RecordedCall } from './_mockApi';

// A silence monitor's sightings: the calls (or emissions) it counts off the chain's record,
// how long it has been quiet, and the stretches that outgrew its window.
const SAVAX = '0x2b2c81e08f1af8835a78bb2a90ae924ace0ea4be';
const query = (call: RecordedCall) => Object.fromEntries(new URLSearchParams(call.path.split('?')[1] ?? ''));
const tx = (n: number) => `0x${String(n).repeat(64).slice(0, 64)}`;

const silence = {
    id: 'inv9',
    name: 'sAVAX rewards stopped accruing',
    kind: 'silence',
    params: { kind: 'silence', chainId: 43114, address: SAVAX, topic0: null, events: [], selector: '0x1f1e8c5a', windowSec: 21_600, subject: 'accrueRewards' },
    exprAst: { type: 'watch', kind: 'silence' },
    exprText: 'accrueRewards has not been called for 6 hours',
    warnExprAst: null,
    warnExprText: null,
    enabled: true,
    status: 'ok',
    channelIds: [],
    inputs: [],
    snoozedUntil: null,
    maxInputAgeSec: null,
    notifyAll: false,
    lastEvalInputs: { watch: 'silence', words: '', txHash: null, lastSeen: 1_759_650_000 },
};
const threshold = {
    id: 'inv1',
    name: 'Treasury · Native balance',
    kind: null,
    exprAst: { type: 'cmp', op: 'gte', lhs: { type: 'ref', alias: 'treasury' }, rhs: { type: 'lit', num: '25000', den: '1' } },
    exprText: 'treasury >= 25000',
    warnExprAst: null,
    warnExprText: null,
    enabled: true,
    status: 'ok',
    channelIds: [],
    inputs: [],
    snoozedUntil: null,
    maxInputAgeSec: null,
    notifyAll: false,
};

/** Four sightings over a day, with an 8-hour hole and a 14h 20m quiet tail, to a frontier five minutes back. */
function sightings(): SightingsPayload {
    const toSec = Math.floor(Date.now() / 1000) - 300;
    const fromSec = toSec - 86_400;
    const s1 = fromSec + 3600;
    const s2 = s1 + 1800;
    const s3 = s2 + 8 * 3600;
    const s4 = s3 + 600;
    const list = [s1, s2, s3, s4].map((s, i) => ({ s, tx: tx(i + 1) }));
    return {
        range: '24h',
        stepSec: 300,
        fromSec,
        toSec,
        frontierSec: toSec,
        total: 4,
        capped: false,
        sightings: list,
        bins: list.map((x) => ({ t: Math.floor(x.s / 300) * 300, n: 1 })),
    };
}

describe('quiet stretches', () => {
    it('finds the holes longer than the window: between sightings, the tail, and a lower-bound head', () => {
        const p = sightings();
        const q = quietStretches(p, 21_600);
        expect(q.map((s) => [s.toSec - s.fromSec, s.before?.tx.slice(0, 4), s.after?.tx.slice(0, 4)])).toEqual([
            [8 * 3600, '0x22', '0x33'],
            [p.toSec - p.sightings[3].s, '0x44', undefined],
        ]);
        expect(quietStretches({ ...p, capped: true }, 21_600)).toEqual([]);
        expect(quietStretches({ ...p, sightings: [], total: 0, bins: [] }, 21_600)).toEqual([{ fromSec: p.fromSec, toSec: p.toSec, before: null, after: null }]);
        const head = quietStretches({ ...p, sightings: p.sightings.slice(2) }, 21_600);
        expect(head[0]).toEqual({ fromSec: p.fromSec, toSec: p.sightings[2].s, before: null, after: p.sightings[2] });
        expect(windowWords(1800)).toBe('30 minutes');
        expect(windowWords(21_600)).toBe('6 hours');
        expect(windowWords(3 * 86_400)).toBe('3 days');
    });
});

describe('monitor show / sightings on a silence monitor', () => {
    useEnvAuth();

    const base = {
        'GET /api/mainnet/invariants': () => ({ payload: { invariants: [silence, threshold] } }),
        'GET /api/mainnet/invariants/inv9': () => ({ payload: { invariant: { ...silence, incidents: [] } } }),
        'GET /api/cli/alert-channels': () => ({ payload: { channels: [] } }),
    };

    it('show reads the sightings and prints the count, how long quiet, the longest gap, the strip and the quiet stretches', async () => {
        const p = sightings();
        const calls = mockApi({ ...base, 'GET /api/mainnet/invariants/inv9/sightings': () => ({ payload: p }) });
        await run(['monitor', 'show', 'sAVAX rewards stopped accruing', '--range', '7d']);
        expect(query(calls.find((c) => c.path.includes('/sightings'))!)).toEqual({ range: '7d' });
        const out = printed();
        expect(out[0]).toBe('sAVAX rewards stopped accruing  (inv9)');
        expect(out).toContain(`  watches: accrueRewards on ${SAVAX} (chain 43114)`);
        expect(out).toContain('  window:  alerts after 6 hours without a call');
        expect(out.find((l) => l.startsWith('  sightings:'))).toMatch(
            /^ {2}sightings: 4 calls in the last 24h · last seen 14h 2[45]m ago \(\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\) · quiet 14h 20m \(over the window\) · longest gap 14h 20m$/,
        );
        expect(out.some((l) => /^ {4}[▁-█ ]+ {2}5m bins$/.test(l))).toBe(true);
        expect(out).toContain('    quiet stretches over 6 hours: 2');
        const stretches = out.filter((l) => l.startsWith('      '));
        expect(stretches[0]).toMatch(/UTC → .* UTC · 8h · after 0x2222…2222 · ended by 0x3333…3333$/);
        expect(stretches[1]).toMatch(/UTC · 14h 20m · after 0x4444…4444 · still quiet at the end of the record$/);
        expect(out.some((l) => l.startsWith('  inputs:'))).toBe(false);
    });

    it('show says when nothing was seen, when the record is capped, and when the chain is not collected', async () => {
        const p = sightings();
        mockApi({ ...base, 'GET /api/mainnet/invariants/inv9/sightings': () => ({ payload: { ...p, total: 0, sightings: [], bins: [] } }) });
        await run(['monitor', 'show', 'inv9']);
        expect(printed().find((l) => l.startsWith('  sightings:'))).toMatch(/^ {2}sightings: 0 calls in the last 24h · last seen .* ago \(2025-10-05 \d{2}:\d{2} UTC\), from the monitor's own record · quiet /);

        mockApi({ ...base, 'GET /api/mainnet/invariants/inv9/sightings': () => ({ payload: { ...p, total: 5000, capped: true } }) });
        await run(['monitor', 'show', 'inv9']);
        expect(printed()).toContain('    quiet stretches: not read — the sightings are a sample at this volume');

        mockApi({ ...base, 'GET /api/mainnet/invariants/inv9/sightings': () => ({ payload: { ...p, frontierSec: null, total: 0, sightings: [], bins: [] } }) });
        await run(['monitor', 'show', 'inv9']);
        expect(printed()).toContain('  sightings: chain not collected');
    });

    it('sightings lists them newest first, up to --limit; a threshold monitor has none', async () => {
        const p = sightings();
        mockApi({ ...base, 'GET /api/mainnet/invariants/inv9/sightings': () => ({ payload: p }) });
        await run(['monitor', 'sightings', 'inv9', '--limit', '2']);
        const out = printed();
        expect(out[0]).toBe('sAVAX rewards stopped accruing · sightings · last 24h');
        expect(out[1]).toMatch(/^4 calls between \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC and \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
        const rows = out.filter((l) => /^ {2}\d{4}-/.test(l));
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatch(/0x4444/);
        expect(rows[1]).toMatch(/0x3333/);
        expect(out.at(-1)).toBe('  … 2 more (--limit, or --json for all)');

        mockApi(base);
        await expect(run(['monitor', 'sightings', 'inv1'])).rejects.toThrow('"Treasury · Native balance" is not a silence monitor — sightings are what a silence monitor counts.');
    });
});
