// The platform's tools — the typed questions and actions a chat agent loads — over one route:
// GET /api/mainnet/tools lists them, POST /api/mainnet/tools/<name> runs one as this key.
// `find`, `describe`, `compare`, `activity query` and `monitor add` read through here, so a
// person at the terminal and an agent get the same answer to the same question.
import { apiRequest, ApiRequestError, ResolvedAuth } from './credentials';

export interface ToolCatalogueEntry {
  name: string;
  title: string;
  /** Written for a model: what it answers, in which unit, and its edge. */
  description: string;
  /** read · contracts:write · metrics:write · monitors:write · reports:write */
  scope: string;
  /** A JSON Schema object: type, properties, required, enum, description. */
  input: Record<string, unknown>;
}

export interface ToolEnvelope<T = unknown> {
  ok: true;
  result: T;
  ms: number;
}

interface ToolFailure {
  ok: false;
  error: string;
  code: string | null;
}

/** A tool's refusal: the server's sentence, written to be shown as it is, and its code. */
export class ToolRunError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ToolRunError';
  }
}

export async function listTools(auth: ResolvedAuth): Promise<ToolCatalogueEntry[]> {
  const { tools } = await apiRequest<{ tools: ToolCatalogueEntry[] }>(auth, 'GET', '/api/mainnet/tools');
  return tools ?? [];
}

// A tool may read the store, rank every contract or backtest a monitor; the route allows itself a minute.
const TOOL_TIMEOUT_MS = 60_000;

/** Run one tool; the envelope back, or a ToolRunError in the server's words. */
export async function callTool<T = unknown>(auth: ResolvedAuth, name: string, input: Record<string, unknown> = {}): Promise<ToolEnvelope<T>> {
  let payload: ToolEnvelope<T> | ToolFailure | null;
  try {
    payload = await apiRequest<ToolEnvelope<T> | ToolFailure>(auth, 'POST', `/api/mainnet/tools/${encodeURIComponent(name)}`, { input }, { timeoutMs: TOOL_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof ApiRequestError) {
      const body = err.payload as Partial<ToolFailure> | null;
      throw new ToolRunError(body?.error || err.message, body?.code ?? null, err.status);
    }
    throw err;
  }
  if (!payload || payload.ok !== true) {
    const failed = payload as ToolFailure | null;
    throw new ToolRunError(failed?.error || `The ${name} tool did not answer.`, failed?.code ?? null, 200);
  }
  return payload;
}

/** A tool's result alone — what the ask commands print and hand to --json. */
export async function runTool<T = unknown>(auth: ResolvedAuth, name: string, input: Record<string, unknown> = {}): Promise<T> {
  return (await callTool<T>(auth, name, input)).result;
}
