import { run } from '../../src/cli/index';
import { mockApi, useEnvAuth } from './_mockApi';
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
    expect(() => definitionFrom(parseFlags(['x', '--history', '120']))).toThrow(/1 to 89/);
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

describe('metric monitor: one formula', () => {
    useEnvAuth();
    const made = () => ({ payload: { ok: true, result: { monitor: { id: 'mm2', name: 'x' } }, ms: 3 } });

    it('a window against its own past is --when, sent as {metric, name, when}; --per, --level, --to and --preview ride along', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/add_metric_monitor': made });
        await run(['metric', 'monitor', 'Swap fees', '--name', 'Fees jump', '--when', 'total(1h) > before(1h) * 1.1']);
        expect(calls[0].body.input).toEqual({ metric: 'Swap fees', name: 'Fees jump', when: 'total(1h) > before(1h) * 1.1' });
        await run(['metric', 'monitor', 'Swap fees', '--name', 'Busy pool', '--when', 'total(1h) > 3 * usual(1h, 7d)', '--per', 'each', '--level', 'warning', '--to', '#alerts', '--preview']);
        expect(calls[1].body.input).toEqual({ metric: 'Swap fees', name: 'Busy pool', when: 'total(1h) > 3 * usual(1h, 7d)', per: 'each', level: 'warning', to: ['#alerts'], preview: true });
    });

    it('refuses no --when, and a flag it does not take, before calling', async () => {
        const calls = mockApi({});
        await expect(run(['metric', 'monitor', 'Swap fees', '--name', 'x'])).rejects.toThrow(/--when says when it alerts/);
        await expect(run(['metric', 'monitor', 'Swap fees', '--name', 'x', '--window', '1h', '--above', '5'])).rejects.toThrow('Unknown flag --window for metric monitor. It takes --name, --when, --per, --level, --to, --preview.');
        await expect(run(['metric', 'monitor', 'Swap fees', '--name', 'x', '--when', 'total(1h) > 5', '--baseline-days', '7'])).rejects.toThrow(/^Unknown flag --baseline-days for metric monitor\./);
        expect(calls).toHaveLength(0);
    });
});
