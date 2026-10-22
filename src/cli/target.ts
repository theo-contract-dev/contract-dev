import { setWorkspaceOverride } from './credentials';

// Per-invocation targeting override. The entrypoint strips --workspace from argv before
// command dispatch, so subcommand parsers never see it.
export function extractTargetFlags(args: string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--workspace') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--workspace requires a value');
      setWorkspaceOverride(value);
      i++;
      continue;
    }
    if (arg.startsWith('--workspace=')) {
      setWorkspaceOverride(arg.slice('--workspace='.length));
      continue;
    }
    rest.push(arg);
  }
  return rest;
}

// Test hook — module state would otherwise leak between jest cases.
export function resetTargetOverrides(): void {
  setWorkspaceOverride(undefined);
}
