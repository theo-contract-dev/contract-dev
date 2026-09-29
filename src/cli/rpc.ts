// Minimal JSON-RPC client used by CLI commands. RPC methods used by the CLI
// (like dev_importContracts) live here so the public SDK surface stays clean.

type JsonRpcResponse<T> = {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
};

// Generous: a push of many contracts or a state reset can take a while, but a stagenet
// that never answers must not hang the terminal.
export const RPC_TIMEOUT_MS = 120_000;

export async function callRpc<T>(rpcUrl: string, method: string, params: unknown[] = []): Promise<T> {
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`The stagenet did not answer ${method} within ${RPC_TIMEOUT_MS / 1000}s — is it online?`);
    }
    throw new Error(`Could not reach the stagenet at ${rpcUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    throw new Error(`RPC request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as JsonRpcResponse<T>;
  if (payload.error) {
    throw new Error(payload.error.message || 'RPC error');
  }
  return payload.result as T;
}
