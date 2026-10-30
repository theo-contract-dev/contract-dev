// Every test runs as a person at a terminal unless it says otherwise: a watch asks an agent for
// --about (src/cli/about.ts), and whether the suite was started from a terminal, a CI job or an
// agent's shell (which sets CLAUDECODE / AI_AGENT) must not change what the tests see.
delete process.env.CLAUDECODE;
delete process.env.AI_AGENT;
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true, writable: true });
