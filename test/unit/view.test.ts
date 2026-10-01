import { fmtAge, fmtChange, fmtCompact, fmtInt, fmtPct, fmtUsd, fmtUsdSigned, sparkline, table } from '../../src/cli/view';
import { matchContract } from '../../src/cli/data';
import { fmtNative, sourceFiles } from '../../src/cli/commands/explorer';
import { totalSeries } from '../../src/cli/commands/tvl';
import type { WatchedAccount } from '../../src/cli/commands/watch';

describe('numbers', () => {
    it('prints a measured zero as 0 and an unknown as a dash', () => {
        expect(fmtInt(0)).toBe('0');
        expect(fmtInt(null)).toBe('—');
        expect(fmtUsd(0)).toBe('$0');
        expect(fmtUsd(undefined)).toBe('—');
        expect(fmtCompact(0)).toBe('0');
        expect(fmtPct(0)).toBe('0.0%');
        expect(fmtPct(null)).toBe('—');
    });

    it('compacts counts and dollars the way the dashboard does', () => {
        expect(fmtCompact(950)).toBe('950');
        expect(fmtCompact(12_400)).toBe('12.4K');
        expect(fmtCompact(3_210_000)).toBe('3.21M');
        expect(fmtCompact(0.000123)).toBe('0.000123');
        expect(fmtUsd(12_400)).toBe('$12.4K');
        expect(fmtUsd(3_210_000)).toBe('$3.21M');
        expect(fmtUsd(12_885_647_375)).toBe('$12.89B');
        expect(fmtUsdSigned(4_960_000)).toBe('+$4.96M');
        expect(fmtUsdSigned(-40_000)).toBe('-$40.0K');
    });

    it('gives a change against the previous window, and a dash with no base', () => {
        expect(fmtChange(120, 100)).toBe('+20%');
        expect(fmtChange(97.4, 100)).toBe('-2.6%');
        expect(fmtChange(5, 0)).toBe('—');
        expect(fmtChange(5, null)).toBe('—');
    });

    it('ages compactly', () => {
        const now = 1_000_000_000_000;
        expect(fmtAge(now - 42_000, now)).toBe('42s');
        expect(fmtAge(now - 12 * 60_000, now)).toBe('12m');
        expect(fmtAge(now - 3 * 3_600_000, now)).toBe('3h');
        expect(fmtAge(now - 2 * 86_400_000, now)).toBe('2d');
        expect(fmtAge(null, now)).toBe('—');
    });

    it('formats wei as the chain\'s coin', () => {
        expect(fmtNative('0', 1)).toBe('0 ETH');
        expect(fmtNative('1500000000000000000', 1)).toBe('1.5 ETH');
        expect(fmtNative('6445784935440', 1)).toBe('0.000006445 ETH');
        expect(fmtNative('25768000000000000000000', 1)).toBe('25,768 ETH');
        expect(fmtNative('2000000000000000000', 43114)).toBe('2 AVAX');
        expect(fmtNative('-270283516704', 1)).toBe('-0.0000002702 ETH');
    });
});

describe('table', () => {
    it('aligns columns under a header, numbers to the right, long cells clipped', () => {
        const lines = table(
            [
                { name: 'transfer', calls: 1126 },
                { name: 'a-very-long-method-name-here', calls: 7 },
            ],
            [
                { header: 'Method', value: (r) => r.name, max: 12 },
                { header: 'Calls', value: (r) => r.calls.toLocaleString('en-US'), align: 'right' },
            ],
        );
        expect(lines).toEqual(['Method        Calls', 'transfer      1,126', 'a-very-long…      7']);
    });
});

describe('sparkline', () => {
    it('puts counts on a zero floor', () => {
        expect(sparkline([0, 4, 8])).toBe('▁▅█');
        expect(sparkline([0, 0])).toBe('▁▁');
    });

    it('draws a level between its own low and high, and leaves gaps empty', () => {
        expect(sparkline([100, 101, 102], { floor: 'min' })).toBe('▁▅█');
        expect(sparkline([100, null, 102], { floor: 'min' })).toBe('▁ █');
    });

    it('fits a long series into the width, keeping the last value of each stretch', () => {
        const line = sparkline(Array.from({ length: 98 }, (_, i) => i), { width: 49, floor: 'min' });
        expect(line).toHaveLength(49);
        expect(line[0]).toBe('▁');
        expect(line[48]).toBe('█');
    });
});

describe('totalSeries', () => {
    it('sums the chains slot by slot, leaving a slot no chain read empty', () => {
        expect(
            totalSeries([
                { chainId: 1, contracts: 1, values: [10, 11, null], liveUsd: 11 },
                { chainId: 43114, contracts: 1, values: [1, null, null], liveUsd: 1 },
            ]),
        ).toEqual([11, 11, null]);
    });
});

describe('matchContract', () => {
    const c = (name: string | null, address: string, chainId = 1): WatchedAccount => ({
        id: address,
        chainId,
        chainIds: [chainId],
        address,
        accountType: 'contract',
        name,
    });
    const steth = c('Lido: stETH', '0xae7ab96520de3a18e5e111b5eaab095312d7fe84');
    const wsteth = c('Lido: wstETH', '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0');
    const queue = c('Lido: Withdrawal Queue', '0x889edc2edab5f40e902b864ad4d7ade8e412f9b1');
    const usdcEth = c('USDC', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    const usdcArb = c('USDC', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 42161);
    const all = [steth, wsteth, queue, usdcEth, usdcArb];

    it('takes an address in any case', () => {
        expect(matchContract(all, '0xAE7AB96520DE3A18E5E111B5EAAB095312D7FE84')).toBe(steth);
    });

    it('takes the exact name, then a whole word of one, then any part', () => {
        expect(matchContract(all, 'lido: steth')).toBe(steth);
        expect(matchContract(all, 'steth')).toBe(steth);
        expect(matchContract(all, 'withdrawal')).toBe(queue);
        expect(matchContract(all, 'wsteth')).toBe(wsteth);
    });

    it('asks for more when a name or an address is ambiguous', () => {
        expect(() => matchContract(all, 'lido')).toThrow(/matches 3 watched contracts/);
        expect(() => matchContract(all, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toThrow(/--chain/);
        expect(matchContract(all, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 42161)).toBe(usdcArb);
    });

    it('says what to do about a contract it does not know', () => {
        expect(() => matchContract(all, '0x0000000000000000000000000000000000000001')).toThrow(/not watched.*contract\.dev watch/);
        expect(() => matchContract(all, 'uniswap')).toThrow(/No watched contract is called "uniswap"/);
    });
});

describe('sourceFiles', () => {
    it('reads the three shapes the explorer stores source in', () => {
        expect(sourceFiles('Token', 'pragma solidity ^0.8.0;')).toEqual({ 'Token.sol': 'pragma solidity ^0.8.0;' });
        expect(sourceFiles('X', JSON.stringify({ 'A.sol': { content: 'a' }, 'B.sol': { content: 'b' } }))).toEqual({ 'A.sol': 'a', 'B.sol': 'b' });
        const standard = `{${JSON.stringify({ language: 'Solidity', sources: { 'src/C.sol': { content: 'c' } } })}}`;
        expect(sourceFiles('C', standard)).toEqual({ 'src/C.sol': 'c' });
    });
});
