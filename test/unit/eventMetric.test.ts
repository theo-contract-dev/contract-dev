import { run } from '../../src/cli/index';
import { mockApi, useEnvAuth, printed } from './_mockApi';
import { parseRead, definitionFrom } from '../../src/cli/commands/eventMetric';
import { parseFlags } from '../../src/cli/commands/_args';

describe('event metric flags', () => {
  it('reads a plain call, an output, a target and arguments', () => {
    expect(parseRead('fee=fee()', new Set())).toEqual({ name: 'fee', call: 'fee()' });
    expect(parseRead('price=slot0().sqrtPriceX96', new Set())).toEqual({ name: 'price', call: 'slot0()', output: 'sqrtPriceX96' });
    expect(parseRead('dec=decimals() returns (uint8) on t0', new Set())).toEqual({ name: 'dec', call: 'decimals() returns (uint8)', on: 't0' });
    expect(parseRead('f=getFee(address,uint256) on 0x2222222222222222222222222222222222222222 with emitter(), if(a > 0, a, 0)', new Set(['f']))).toEqual({
      name: 'f',
      call: 'getFee(address,uint256)',
      on: '0x2222222222222222222222222222222222222222',
      args: ['emitter()', 'if(a > 0, a, 0)'],
      fixed: true,
    });
    expect(() => parseRead('fee()', new Set())).toThrow(/name=call/);
  });

  it('turns the define flags into the tool input, in order', () => {
    const flags = parseFlags(['Swap fees', '--event', 'Swap', '--read', 'fee=fee()', '--read', 't0=token0()', '--field', 'in0=if(amount0 > 0, amount0, 0)', '--value', 'usd(in0 * fee / 1000000, t0)', '--history', '7d', '--fixed', 't0']);
    expect(definitionFrom(flags)).toEqual({
      events: ['Swap'],
      reads: [{ name: 'fee', call: 'fee()' }, { name: 't0', call: 'token0()', fixed: true }],
      fields: [{ name: 'in0', expr: 'if(amount0 > 0, amount0, 0)' }],
      value: 'usd(in0 * fee / 1000000, t0)',
      history: 7,
    });
    expect(() => definitionFrom(parseFlags(['x', '--history', '400']))).toThrow(/1 to 365/);
  });

  it('a field "on <Event>" is for that event alone; a trailing "on" that names no counted event stays in the expression', () => {
    const d = definitionFrom(parseFlags(['x', '--event', 'BridgeStarted', '--event', 'CctpBridgeTransferStarted', '--field', 'amt=amount on BridgeStarted', '--field', 'amt=amountIn on CctpBridgeTransferStarted', '--field', 'tok=from']));
    expect(d.fields).toEqual([
      { name: 'amt', expr: 'amount', on: 'BridgeStarted' },
      { name: 'amt', expr: 'amountIn', on: 'CctpBridgeTransferStarted' },
      { name: 'tok', expr: 'from' },
    ]);
    // an update names no events: any name after "on" is taken as one, and the server checks it
    expect(definitionFrom(parseFlags(['x', '--field', 'amt=amountIn on CctpBridgeTransferStarted'])).fields).toEqual([{ name: 'amt', expr: 'amountIn', on: 'CctpBridgeTransferStarted' }]);
    expect(definitionFrom(parseFlags(['x', '--event', 'Swap', '--field', 'x=a on b'])).fields).toEqual([{ name: 'x', expr: 'a on b' }]);
  });

  it('--line says what one line of the split is', () => {
    const d = definitionFrom(parseFlags(['x', '--event', 'GardenRedistributed', '--split', 'index', '--line', 'an index']));
    expect(d.split).toBe('index');
    expect(d.line).toBe('an index');
  });
});

import { parseFormulaCall } from '../../src/cli/commands/eventMetric';

describe('formula calls', () => {
  it('reads decimals, a target and arguments', () => {
    expect(parseFormulaCall('pooled=getTotalPooledEther() decimals 18')).toEqual({ name: 'pooled', call: 'getTotalPooledEther()', decimals: 18 });
    expect(parseFormulaCall('bal=balanceOf(address) on 0x2222222222222222222222222222222222222222 with 0x3333333333333333333333333333333333333333 decimals 6')).toEqual({
      name: 'bal',
      call: 'balanceOf(address)',
      on: '0x2222222222222222222222222222222222222222',
      args: ['0x3333333333333333333333333333333333333333'],
      decimals: 6,
    });
    expect(parseFormulaCall('r=getReserves().reserve0')).toEqual({ name: 'r', call: 'getReserves()', output: 'reserve0' });
  });
});

describe('metric monitor without a destination', () => {
    useEnvAuth();
    it('leaves `to` out, so the alert is recorded in the app until a destination is linked', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/add_metric_monitor': () => ({ payload: { ok: true, result: { monitor: { id: 'mm1', name: 'Large swap fee' } }, ms: 3 } }) });
        await run(['metric', 'monitor', 'Swap fees', '--name', 'Large swap fee', '--when', 'value > 5000']);
        expect(calls[0].body.input).toEqual({ metric: 'Swap fees', name: 'Large swap fee', when: 'value > 5000' });
    });
});

describe('track formula --preview', () => {
    useEnvAuth();
    const DSA = '0x9600a48ed0f931d0c422d574e3275a90d8b22745';
    const args = ['track', 'formula', DSA, '--label', 'wstETH APR', '--call', 'r=stEthPerToken() on 0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0 decimals 18', '--value', '(r - ago(r, 7d)) / ago(r, 7d) * 365 / 7 * 100'];
    it('asks the tool for a preview and prints the value, each call and each ago() reading; nothing is saved', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/track_formula': () => ({ payload: { ok: true, result: {
                preview: true,
                value: { label: 'wstETH APR', contract: 'Instadapp DSA', formula: '(r - ago(r, 7d)) / ago(r, 7d) * 365 / 7 * 100' },
                now: { value: '2.223871', calls: [{ name: 'r', answer: '1.2468' }], earlier: [{ name: 'r', ago: '7d', answer: '1.2463' }] },
                note: 'Nothing saved.',
            }, ms: 3 } }),
        });
        await run([...args, '--preview']);
        expect(calls[0].body.input).toMatchObject({ contract: DSA, label: 'wstETH APR', preview: true });
        const out = printed().join('\n');
        expect(out).toMatch(/^Preview: nothing saved\./);
        expect(out).toMatch(/Value now: 2\.223871/);
        expect(out).toMatch(/r, 7d ago\s+1\.2463/);
    });
    it('without --preview it saves (no preview in the input); an unknown flag is refused, never ignored', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/track_formula': () => ({ payload: { ok: true, result: { saved: true }, ms: 3 } }) });
        await run(args);
        expect(calls[0].body.input.preview).toBeUndefined();
        await expect(run([...args, '--dry-run'])).rejects.toThrow(/Unknown flag --dry-run for track formula/);
    });
});
