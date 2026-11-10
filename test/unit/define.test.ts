import { run } from '../../src/cli/index';
import { mockApi, useEnvAuth, printed } from './_mockApi';
import { clausesToArgs, defineInputFromClauses, defineInputFromFlags, inlineDefinition, splitClauses } from '../../src/cli/commands/_define';
import { parseFlags } from '../../src/cli/commands/_args';
import { rewriteTableArgs } from '../../src/cli/commands/table';
import { inlineMetrics, monitorArgs } from '../../src/cli/commands/notify';
import { parseRow, tableClausesToArgs, tableSpecFromFlag } from '../../src/cli/commands/report';
import { requireAuth } from '../../src/cli/credentials';

const defined = (id: string, name: string, kind: 'state' | 'activity' = 'state') => ({ payload: { ok: true, result: { created: true, metric: { id, name, kind, source: kind === 'state' ? 'tracked' : 'custom', on: 'Lido stETH' }, url: `https://app/metrics/${id}` }, ms: 1 } });

describe('one grammar for a metric', () => {
  it('turns the define flags into the tool input: on, call (a state metric) or each (an activity metric)', () => {
    expect(defineInputFromFlags('stETH supply', parseFlags(['stETH supply', '--on', 'steth', '--call', 'totalSupply()']))).toEqual({ name: 'stETH supply', on: 'steth', call: ['totalSupply()'] });
    expect(defineInputFromFlags('Per share', parseFlags(['x', '--on', 'steth', '--call', 'pooled=getTotalPooledEther() decimals 18', '--call', 'shares=getTotalShares() decimals 18', '--value', 'pooled / shares', '--hidden']))).toEqual({
      name: 'Per share',
      on: 'steth',
      call: ['pooled=getTotalPooledEther() decimals 18', 'shares=getTotalShares() decimals 18'],
      value: 'pooled / shares',
      listed: false,
    });
    expect(defineInputFromFlags('Swap fees', parseFlags(['x', '--on', 'tag:pools', '--each', 'Swap', '--read', 'fee=fee()', '--value', 'usd(amount0 * fee, token0())', '--history', '7']))).toEqual({
      name: 'Swap fees',
      on: 'tag:pools',
      each: ['Swap'],
      reads: [{ name: 'fee', call: 'fee()' }],
      value: 'usd(amount0 * fee, token0())',
      history: 7,
    });
    // the older words are the same input
    expect(defineInputFromFlags('x', parseFlags(['x', '--group', 'pools', '--event', 'Swap']))).toEqual({ name: 'x', on: 'tag:pools', each: ['Swap'] });
    expect(defineInputFromFlags('x', parseFlags(['x', '--contract', 'steth', '--chain', '1', '--event', 'Swap']))).toEqual({ name: 'x', on: 'steth', chainId: 1, each: ['Swap'] });
    expect(defineInputFromFlags('x', parseFlags(['x', '--on', 'table:Positions', '--column', 'Value', '--among', 'active', '--token', '0xabc', '--show', 'usd', '--decimals', '18']))).toEqual({ name: 'x', on: 'table:Positions', column: 'Value', among: 'active', token: '0xabc', show: 'usd', decimals: 18 });
    expect(() => defineInputFromFlags('x', parseFlags(['x', '--show', 'eur']))).toThrow(/--show takes usd/);
    expect(() => defineInputFromFlags('x', parseFlags(['x', '--decimals', '40']))).toThrow(/0 to 36/);
  });

  it('reads an inline definition as the same flags', () => {
    expect(splitClauses('on steth; call balanceOf(self) on 0xA; value a; where usd(x, "a;b") > 1')).toEqual(['on steth', 'call balanceOf(self) on 0xA', 'value a', 'where usd(x, "a;b") > 1']);
    expect(clausesToArgs('on tag:pools; each Swap, Mint; aggregate count; hidden')).toEqual(['--on', 'tag:pools', '--each', 'Swap', '--each', 'Mint', '--aggregate', 'count', '--hidden']);
    expect(defineInputFromClauses('LP value', 'on table:Positions; column Value')).toEqual({ name: 'LP value', on: 'table:Positions', column: 'Value' });
    expect(() => clausesToArgs('on steth; colour red')).toThrow(/Unknown clause "colour"/);
    expect(() => clausesToArgs('on steth; call')).toThrow(/needs a value/);
    expect(inlineDefinition('Supply=on steth; call totalSupply()')).toEqual({ name: 'Supply', clauses: 'on steth; call totalSupply()' });
    // a name alone, or an = inside a call, is not a definition
    expect(inlineDefinition('Swap fees')).toBeNull();
    expect(inlineDefinition('balanceOf(a=b)')).toBeNull();
  });

  it('turns the table grammar into the older flags: --on, --each, --rows', () => {
    expect(rewriteTableArgs(['Loans', '--on', 'tag:markets', '--each', 'LoanOpened', '--id', 'loanId', '--column', 'Owed=accountDebt(id())'])).toEqual(['Loans', '--group', 'markets', '--opens', 'LoanOpened', '--id', 'loanId', '--column', 'Owed=accountDebt(id())']);
    expect(rewriteTableArgs(['Big swaps', '--on', 'tag:pools', '--each', 'Swap', '--where', 'x > 1'])).toEqual(['Big swaps', '--group', 'pools', '--event', 'Swap', '--where', 'x > 1', '--from', 'events']);
    expect(rewriteTableArgs(['Out', '--on', 'treasury', '--rows', 'transfers'])).toEqual(['Out', '--contract', 'treasury', '--from', 'transfers']);
    expect(rewriteTableArgs(['Whales', '--on', 'table:Big swaps', '--by', 'signer'])).toEqual(['Whales', '--from', 'Big swaps', '--by', 'signer']);
    expect(rewriteTableArgs(['All', '--on', 'workspace', '--rows', 'wallets'])).toEqual(['All', '--from', 'wallets']);
  });

  it('keeps --each an activity table when --status, a plain --column or a --by measure come with it', () => {
    // --status is both kinds' pill, and a --column naming a field is an activity table's column
    expect(rewriteTableArgs(['Swaps', '--on', 'tag:pools', '--each', 'Swap', '--status', 'Size: Big={usd} > 100000; Small'])).toEqual(['Swaps', '--group', 'pools', '--event', 'Swap', '--status', 'Size: Big={usd} > 100000; Small', '--from', 'events']);
    expect(rewriteTableArgs(['Swaps', '--on', 'tag:pools', '--each', 'Swap', '--column', 'time', '--column=wallet'])).toEqual(['Swaps', '--group', 'pools', '--event', 'Swap', '--column', 'time', '--column=wallet', '--from', 'events']);
    // --sum and --count with --by are the measure, not a state table's event columns
    expect(rewriteTableArgs(['Top', '--on', 'tag:pools', '--each', 'Swap', '--by', 'wallet', '--sum', '{vol}'])).toEqual(['Top', '--group', 'pools', '--event', 'Swap', '--by', 'wallet', '--sum', '{vol}', '--from', 'events']);
    expect(rewriteTableArgs(['Busiest', '--on', 'tag:pools', '--each', 'Swap', '--by', 'wallet', '--count'])).toEqual(['Busiest', '--group', 'pools', '--event', 'Swap', '--by', 'wallet', '--count', '--from', 'events']);
    // a --column that reads, a --status beside --id, or --sum without --by still makes a state table
    expect(rewriteTableArgs(['Loans', '--on', 'tag:markets', '--each', 'LoanOpened', '--column', 'Owed=accountDebt(id())'])).toEqual(['Loans', '--group', 'markets', '--opens', 'LoanOpened', '--column', 'Owed=accountDebt(id())']);
    expect(rewriteTableArgs(['Loans', '--on', 'tag:markets', '--each', 'LoanOpened', '--id', 'loanId', '--status', 'Stage: Closed=seen(LoanClosed); Open'])).toEqual(['Loans', '--group', 'markets', '--opens', 'LoanOpened', '--id', 'loanId', '--status', 'Stage: Closed=seen(LoanClosed); Open']);
    expect(rewriteTableArgs(['Requests', '--on', 'queue', '--each', 'WithdrawalQueued', '--sum', 'WithdrawalPaid.amount:Paid'])).toEqual(['Requests', '--contract', 'queue', '--opens', 'WithdrawalQueued', '--sum', 'WithdrawalPaid.amount:Paid']);
  });
});

describe('metrics and reports over the wire', () => {
  useEnvAuth();

  it('metric define sends define_metric and prints what was made', async () => {
    const calls = mockApi({ 'POST /api/mainnet/tools/define_metric': () => defined('m1', 'stETH supply') });
    await run(['metric', 'define', 'stETH supply', '--on', 'steth', '--call', 'totalSupply()']);
    expect(calls[0].body.input).toEqual({ name: 'stETH supply', on: 'steth', call: ['totalSupply()'] });
    expect(printed()[0]).toMatch(/^Defined stETH supply — a state metric on Lido stETH \(m1\)\.$/);
    await expect(run(['metric', 'define', 'x', '--on', 'steth'])).rejects.toThrow(/--call .* or --each/);
    await expect(run(['metric', 'define', 'x', '--call', 'totalSupply()'])).rejects.toThrow(/--on says what/);
  });

  it('says when it watched the address on the way', async () => {
    mockApi({ 'POST /api/mainnet/tools/define_metric': () => ({ payload: { ok: true, result: { created: true, metric: { id: 'c1', name: 'Swaps', kind: 'activity', source: 'custom', on: 'UniswapV3Pool' }, url: 'u', watched: { chainId: 1, address: '0x88e6', name: 'UniswapV3Pool', kind: 'contract' } }, ms: 1 } }) });
    await run(['metric', 'define', 'Swaps', '--on', '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', '--each', 'Swap']);
    expect(printed()[0]).toBe('Watched UniswapV3Pool (contract, chain 1) to keep its history.');
  });

  it('a report row names a metric of either kind, or defines one for the report', async () => {
    const calls = mockApi({ 'POST /api/mainnet/tools/define_metric': () => defined('h1', 'Supply') });
    const catalogue = { transactions: { label: 'Transactions', unit: 'count', scopes: [], definition: '' } };
    expect(await parseRow(requireAuth(), 'metric:Swap fees', catalogue)).toEqual({ kind: 'metric', params: { ref: 'Swap fees' } });
    expect(await parseRow(requireAuth(), 'metric:Supply=on steth; call totalSupply()', catalogue)).toEqual({ kind: 'metric', params: { ref: 'h1' }, label: 'Supply' });
    expect(calls[0].body.input).toEqual({ name: 'Supply', on: 'steth', call: ['totalSupply()'], listed: false });
    await expect(parseRow(requireAuth(), 'metric', catalogue)).rejects.toThrow(/names a metric/);
    await expect(parseRow(requireAuth(), 'metric:Swap fees@tag:pools', catalogue)).rejects.toThrow(/takes no @scope/);
  });

  it('an alert on a condition takes any metric by name, or one defined for it', async () => {
    const calls = mockApi({ 'POST /api/mainnet/tools/define_metric': () => defined('h2', 'Supply') });
    expect(await inlineMetrics(['Low', '--on', 'metric:stETH supply', '--when', 'value < 1'])).toEqual(['Low', '--value', 'stETH supply', '--when', 'value < 1']);
    expect(await inlineMetrics(['Low', '--on', 'metric:Supply=on steth; call totalSupply()', '--when', 'value < 1'])).toEqual(['Low', '--value', 'h2', '--when', 'value < 1']);
    expect(calls[0].body.input.listed).toBe(false);
    // a contract stays a contract
    expect(await inlineMetrics(['Quiet', '--on', 'steth', '--silence'])).toEqual(['Quiet', '--on', 'steth', '--silence']);
    expect(monitorArgs(['Low', '--value', 'stETH supply', '--when', 'value < 1'])).toEqual(['add', 'stETH supply', '--when', 'value < 1', '--name', 'Low']);
    expect(() => monitorArgs(['x', '--on', 'steth', '--call', 'pause()'])).toThrow(/--method/);
  });

  it('a report --table defines a live table for the report, off /tables, and keeps the report\'s own clauses', async () => {
    expect(tableClausesToArgs('on tag:pools; each Swap, Mint; where usd(a, t) > 1')).toEqual(['--on', 'tag:pools', '--each', 'Swap', '--each', 'Mint', '--where', 'usd(a, t) > 1']);
    const calls = mockApi({ 'POST /api/mainnet/tools/query_transfers': () => ({ payload: { ok: true, result: { columns: [], rows: [], matched: 0, returned: 0, more: false, saved: { id: 't1', url: 'https://app/tables/t1', title: 'Out' } }, ms: 1 } }) });
    const spec = await tableSpecFromFlag('Out=on treasury; rows transfers; where direction == out | top 5');
    expect(spec).toEqual({ table: 't1', name: 'Out', limit: 5 });
    expect(calls[0].body.input.save).toEqual({ title: 'Out', listed: false });
    expect(calls[0].body.input.contract).toBe('treasury');
    // a table named stays a reference
    expect(await tableSpecFromFlag('Swaps | top 3')).toEqual({ table: 'Swaps', limit: 3 });
  });

  it('alert add and alert list are the notify commands; alerts alone is what opened', async () => {
    const calls = mockApi({
      'GET /api/mainnet/invariants': () => ({ payload: { invariants: [] } }),
      'GET /api/mainnet/reports': () => ({ payload: { reports: [], catalogue: {} } }),
      'GET /api/cli/alert-channels': () => ({ payload: { channels: [] } }),
      'GET /api/mainnet/incidents': () => ({ payload: { incidents: [], days: 7 } }),
    });
    await run(['alert', 'list']);
    await run(['alerts']);
    expect(calls.map((c) => c.path.split('?')[0])).toEqual(['/api/mainnet/invariants', '/api/mainnet/reports', '/api/cli/alert-channels', '/api/mainnet/incidents']);
  });
});
