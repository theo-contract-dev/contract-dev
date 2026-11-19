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
    expect(defineInputFromFlags('Swap fees', parseFlags(['x', '--on', 'tag:pools', '--each', 'Swap', '--read', 'fee=fee()', '--value', 'usd(amount0 * fee, token0())', '--last', '7d']))).toEqual({
      name: 'Swap fees',
      on: 'tag:pools',
      each: ['Swap'],
      reads: [{ name: 'fee', call: 'fee()' }],
      value: 'usd(amount0 * fee, token0())',
      history: 7,
    });
    expect(defineInputFromFlags('x', parseFlags(['x', '--on', 'steth', '--chain', '1', '--each', 'Swap']))).toEqual({ name: 'x', on: 'steth', chainId: 1, each: ['Swap'] });
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

  it('hands the table grammar on in the shapes the tools take: --on, --each; --rows is gone', () => {
    expect(rewriteTableArgs(['Loans', '--on', 'tag:markets', '--each', 'LoanOpened', '--id', 'loanId', '--column', 'Owed=accountDebt(id())'])).toEqual(['Loans', '--group', 'markets', '--opens', 'LoanOpened', '--id', 'loanId', '--column', 'Owed=accountDebt(id())']);
    expect(rewriteTableArgs(['Big swaps', '--on', 'tag:pools', '--each', 'Swap', '--where', 'x > 1'])).toEqual(['Big swaps', '--group', 'pools', '--event', 'Swap', '--where', 'x > 1', '--from', 'events']);
    // a table is made from events (2026-11-18): the lists the platform keeps are asked, never kept as a table
    expect(() => rewriteTableArgs(['Out', '--on', 'treasury', '--rows', 'transfers'])).toThrow(/--rows is gone: a table is made from events/);
    expect(rewriteTableArgs(['Whales', '--on', 'table:Big swaps', '--by', 'signer'])).toEqual(['Whales', '--from', 'Big swaps', '--by', 'signer']);
    expect(() => rewriteTableArgs(['All', '--on', 'workspace', '--rows=wallets'])).toThrow(/--rows is gone/);
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
    const calls = mockApi({ 'POST /api/mainnet/tools/query_data': () => ({ payload: { ok: true, result: { columns: [], rows: [], matched: 0, returned: 0, more: false, saved: { id: 't1', url: 'https://app/tables/t1', title: 'Big' } }, ms: 1 } }) });
    const spec = await tableSpecFromFlag('Big=on table:Swaps; where dollars > 10000 | top 5');
    expect(spec).toEqual({ table: 't1', name: 'Big', limit: 5 });
    expect(calls[0].body.input.save).toEqual({ title: 'Big', listed: false });
    expect(calls[0].body.input.data).toBe('Swaps');
    // a table is made from events: the lists the platform keeps are not a report table's rows either
    await expect(tableSpecFromFlag('Out=on treasury; rows transfers; where direction == out | top 5')).rejects.toThrow(/--rows is gone/);
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

describe('the table grammar handed on (5.0.0)', () => {
  it('takes --on= and --each= as it takes the spaced forms', () => {
    expect(rewriteTableArgs(['Loans', '--on=tag:markets', '--each=LoanOpened', '--id', 'loanId'])).toEqual(['Loans', '--group', 'markets', '--opens', 'LoanOpened', '--id', 'loanId']);
    expect(rewriteTableArgs(['Whales', '--on=table:Big swaps', '--by', 'signer'])).toEqual(['Whales', '--from', 'Big swaps', '--by', 'signer']);
  });

  it('several --each: the first opens the rows of a state table and the rest are events a rule may name; every one is a row of an activity table', () => {
    expect(rewriteTableArgs(['Rounds', '--on', 'tag:markets', '--each', 'Opened', '--each', 'Closed', '--id', 'id'])).toEqual(['Rounds', '--group', 'markets', '--opens', 'Opened', '--event', 'Closed', '--id', 'id']);
    expect(rewriteTableArgs(['Flow', '--on', 'tag:pools', '--each', 'Swap', '--each', 'Mint'])).toEqual(['Flow', '--group', 'pools', '--event', 'Swap', '--event', 'Mint', '--from', 'events']);
  });

  it('--found-label and --id-shown make a state table as --id does', () => {
    expect(rewriteTableArgs(['Pools', '--on', 'registry', '--each', 'PoolRegistered', '--found-label', 'Listed'])).toEqual(['Pools', '--contract', 'registry', '--opens', 'PoolRegistered', '--found-label', 'Listed']);
  });
});

describe('metric words (5.0.0)', () => {
  const { refuseGoneFlags, METRIC_GONE } = require('../../src/cli/commands/gone');
  const { showDays, definitionFrom } = require('../../src/cli/commands/eventMetric');
  it('refuses the older scope, event and window words, each with the word that replaced it', async () => {
    for (const [args, said] of [
      [['metric', 'define', 'x', '--group', 'pools', '--each', 'Swap'], '--group is gone: say --on tag:<group> (contract-dev metric define help).'],
      [['metric', 'define', 'x', '--contract', 'steth', '--each', 'Swap'], '--contract is gone: say --on <contract> (contract-dev metric define help).'],
      [['metric', 'define', 'x', '--on', 'steth', '--event', 'Swap'], '--event is gone: say --each <Event> (contract-dev metric define help).'],
      [['metric', 'define', 'x', '--on', 'steth', '--each', 'Swap', '--history', '30'], '--history is gone: say --last <n>d (contract-dev metric define help).'],
      [['metric', 'show', 'Swap fees', '--days', '7'], '--days is gone: say --last <n>d (contract-dev metric help).'],
      [['metric', 'update', 'Swap fees', '--event', 'Swap'], '--event is gone: say --each <Event> (contract-dev metric help).'],
      [['metric', 'table', 'x', '--table', 'Positions'], '--table is gone: say --on table:"<table>" (contract-dev metric help).'],
      [['metric', 'group', 'x', '--group', 'pools', '--column', 'tvl'], '--group is gone: say --on tag:<group> (contract-dev metric help).'],
    ] as [string[], string][])
      await expect(run(args)).rejects.toThrow(said);
    expect(() => refuseGoneFlags(['--range=7d'], METRIC_GONE, 'metric')).toThrow(/--range is gone/);
  });
  it('an inline definition refuses the older words too', () => {
    expect(() => clausesToArgs('on steth; event Swap')).toThrow('"event" is gone: say each <Event>');
    expect(() => clausesToArgs('on steth; each Swap; history 30')).toThrow('"history" is gone: say last <n>d');
    expect(clausesToArgs('on steth; each Swap; last 30d')).toEqual(['--on', 'steth', '--each', 'Swap', '--last', '30d']);
  });
  it('metric show reads --last in whole days, or --since launch', () => {
    expect(showDays(parseFlags(['x', '--last', '2w']))).toBe(14);
    expect(showDays(parseFlags(['x', '--since', 'launch']))).toBe(90);
    expect(() => showDays(parseFlags(['x', '--last', '3h']))).toThrow(/whole days/);
    expect(() => showDays(parseFlags(['x', '--last', '7d', '--since', 'launch']))).toThrow(/one of/);
    expect(definitionFrom(parseFlags(['x', '--each', 'Swap', '--each', 'Mint'])).events).toEqual(['Swap', 'Mint']);
  });
});
