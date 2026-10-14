import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolCommand, readInput } from '../../src/cli/commands/tool';
import { run } from '../../src/cli/index';
import { ToolRunError } from '../../src/cli/tools';
import { mockApi, useEnvAuth, printed } from './_mockApi';

const tools = [
    {
        name: 'find',
        title: 'Find',
        description: 'Resolve a name to things in this workspace.',
        scope: 'read',
        input: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'], additionalProperties: false },
    },
    {
        name: 'create_monitor',
        title: 'Create a monitor',
        description: 'Create the monitor a compile_monitor call described.',
        scope: 'monitors:write',
        input: { type: 'object', properties: { mode: { type: 'string', enum: ['event', 'silence'] }, contract: { type: 'string' } }, required: ['mode', 'contract'] },
    },
];

describe('tool list / show', () => {
    useEnvAuth();

    it('list prints name, scope and title; `tools` is the noun; --json gets the catalogue', async () => {
        const calls = mockApi({ 'GET /api/mainnet/tools': () => ({ payload: { tools } }) });
        const result = await run(['tools']);
        const out = printed();
        expect(out[0]).toMatch(/^Name {2,}Scope {2,}Title$/);
        expect(out[1]).toMatch(/^find {2,}read {2,}Find$/);
        expect(out[2]).toMatch(/^create_monitor {2,}monitors:write {2,}Create a monitor$/);
        expect(calls.map((c) => c.path)).toEqual(['/api/mainnet/tools']);
        expect(result).toEqual({ tools });
    });

    it('show prints the description and the input schema as JSON; a dashed name finds the underscored tool', async () => {
        mockApi({ 'GET /api/mainnet/tools': () => ({ payload: { tools } }) });
        const shown = await toolCommand(['show', 'create-monitor']);
        const out = printed();
        expect(out[0]).toBe('create_monitor — Create a monitor  (monitors:write)');
        expect(out[1]).toBe('Create the monitor a compile_monitor call described.');
        expect(out[3]).toBe('Input:');
        expect(JSON.parse(out.slice(4).join('\n'))).toEqual(tools[1].input);
        expect(shown).toEqual(tools[1]);
        await expect(toolCommand(['show', 'nope'])).rejects.toThrow(/No tool called "nope"\. Tools: find, create_monitor\./);
    });
});

describe('tool run', () => {
    useEnvAuth();

    it('posts the input and prints the result as JSON; the envelope is what --json gets', async () => {
        const result = { contracts: [{ chainId: 1, address: '0xabc', name: 'Pool' }], groups: [] };
        const calls = mockApi({ 'POST /api/mainnet/tools/find': () => ({ payload: { ok: true, result, ms: 12 } }) });
        const envelope = await toolCommand(['run', 'find', '--input', '{"query":"pools","limit":5}']);
        expect(calls[0].body).toEqual({ input: { query: 'pools', limit: 5 } });
        expect(printed()).toEqual([JSON.stringify(result, null, 2)]);
        expect(envelope).toEqual({ ok: true, result, ms: 12 });
    });

    it('no --input sends {}; @file reads the input from a file; a dashed tool name is sent underscored', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/list_monitors': () => ({ payload: { ok: true, result: { monitors: [] }, ms: 1 } }),
            'POST /api/mainnet/tools/compile_monitor': (c) => ({ payload: { ok: true, result: c.body.input, ms: 1 } }),
        });
        await run(['tool', 'run', 'list_monitors']);
        expect(calls[0].body).toEqual({ input: {} });
        const file = join(mkdtempSync(join(tmpdir(), 'contract-dev-')), 'monitor.json');
        writeFileSync(file, JSON.stringify({ mode: 'event', contract: 'steth', event: 'Transfer' }));
        await toolCommand(['run', 'compile-monitor', `--input=@${file}`]);
        expect(calls[1].path).toBe('/api/mainnet/tools/compile_monitor');
        expect(calls[1].body).toEqual({ input: { mode: 'event', contract: 'steth', event: 'Transfer' } });
    });

    it("a refusal is the server's sentence with its code and status, and nothing prints", async () => {
        mockApi({
            'POST /api/mainnet/tools/describe_contract': () => ({
                status: 404,
                payload: { ok: false, error: '0x1234 is not a watched contract in this workspace. Watch it first (watch_contract).', code: 'NOT_WATCHED' },
            }),
        });
        const err = (await toolCommand(['run', 'describe_contract', '--input', '{"contract":"0x1234"}']).catch((e) => e)) as ToolRunError;
        expect(err).toBeInstanceOf(ToolRunError);
        expect(err.message).toBe('0x1234 is not a watched contract in this workspace. Watch it first (watch_contract).');
        expect(err.code).toBe('NOT_WATCHED');
        expect(err.status).toBe(404);
        expect(printed()).toEqual([]);
    });

    it('a 200 that is not ok is a refusal too, and a 5xx without a body gets the status', async () => {
        mockApi({ 'POST /api/mainnet/tools/find': () => ({ payload: { ok: false, error: 'The find tool failed.', code: null } }) });
        await expect(toolCommand(['run', 'find', '--input', '{"query":"x"}'])).rejects.toThrow('The find tool failed.');
        mockApi({ 'POST /api/mainnet/tools/find': () => ({ status: 502, payload: null }) });
        await expect(toolCommand(['run', 'find'])).rejects.toThrow(/Request failed with status 502/);
    });

    it('refuses input that is not a JSON object, a bare --input, and a file that is not there', () => {
        expect(readInput(undefined)).toEqual({});
        expect(readInput('{"a":1}')).toEqual({ a: 1 });
        expect(() => readInput('[1,2]')).toThrow(/--input must be a JSON object/);
        expect(() => readInput('{bad')).toThrow(/--input must be JSON/);
        expect(() => readInput('true')).toThrow(/--input needs JSON/);
        expect(() => readInput('@/nowhere/none.json')).toThrow(/Could not read \/nowhere\/none\.json/);
    });
});
