# Changelog

## 1.2.0 — 2026-09-29

Needs the app deploy that adds `/api/cli/alert-channels/*`, `/api/cli/logout`, bearer auth on
`/api/stagenets` and `/api/mainnet/vitals`, and the `apiKeyId` in `/api/cli/whoami`.

### Added
- `status` — the workspace at a glance: contracts, TVL, 24h transactions, metrics, monitors, open alerts, stagenets.
- `--json` on every command, `--version`.
- `metrics export <id|label> [--range] [--format csv|json]` — a metric's history.
- `monitor exclude|include <default> <address> [--chain]` — leave a contract out of a default monitor.
- `channels test|enable|disable|remove <id|label>`.
- `stagenet create <name> --chain <id|name>`, `stagenet delete <ref> --yes`, `stagenet reset [--every 6h|12h|1d|off] [--show]`.
- `state resync <address>` — drop every local override on a mainnet contract.
- `watch --abi <file>` — an ABI for a contract without verified source.
- `--chain` accepts names (ethereum, arbitrum, avalanche, sepolia, …); `watch list` shows TVL.
- Noun aliases: `contracts list|add|rename|remove`, `metrics track|untrack`, `incident`, `channel`.
- Every command answers `help`.

### Changed
- Credentials are bound to one workspace; `workspace use` runs the login again for another one.
  The workspace header and `CONTRACT_DEV_WORKSPACE` are gone.
- `logout` revokes the key on the server before deleting the local file.
- `incidents` and `incidents show` print a default monitor's reading (sentence, numbers, transactions).
- `monitor show` on a default monitor lists the contracts it covers and their state.
- Requests time out after 30 s (stagenet RPC: 120 s); reads retry once.
- `watch` prefers the app's own name for an address; `--name` still wins.
- Default monitors resolve by slug (`revert-spike`) as well as by name.
- Help text and README point at the current docs and the Monitoring → Destinations location.

## 1.1.0 — 2026-09-18
- Metrics, monitors, incidents, channels and rename commands.
