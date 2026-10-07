# Changelog

## 1.4.0 — 2026-10-05

Needs the app as deployed on 2026-10-05: an API key on `/api/mainnet/contract/transfer-volume`,
`contract/token-parties`, `console/positions/detail`, `oracles/feed` and `invariants/<id>/sightings`.

### Added
- `events [<contract>]` — the Events tab: every event fired in the window, how often and in how many transactions,
  against the previous window, and the events a contract's ABI declares that never fired.
- `contracts show` covers the whole Overview tab: value held and its 24h change, the activity sparkline, a token's
  own transfer volume, where the ABI comes from, the contract's monitors and their states, its tracked metrics.
- `dependencies` opens with the price feeds the contract reads, as the Dependencies tab does: each Chainlink
  feed's value, how long since it updated against the heartbeat it promises, Fresh / Late / Not assessed, the
  stalest price any read in the window saw, and the reads. `address` on a feed's proxy, SVR proxy or aggregator
  prints the address page's panel: the reading, its age, the verdict, the published terms, the feed's addresses.
- `flows <token>` adds the token's own movements, holder to holder, as the home map shows them for a token: its
  top senders and receivers over the last 24h, with mints, burns and self-transfers left out.
- `positions <contract> <vault|market> [--range]` opens one position in full, the Positions tab's drill-down: a
  vault holding's value, shares, share price, withdrawable amount and vault size, or a lending account's health,
  collateral and debt; the series behind them as lines; the timeline of deposits, withdrawals, supplies, borrows,
  repays and liquidations with their transactions; where the history begins.
- `monitor show` on a silence monitor reads its sightings — the calls or emissions it counts — and says how
  many, how long it has been quiet, the longest gap, and every quiet stretch longer than its window with the
  sightings on either side. `monitor sightings <id|name> [--range 24h|7d|30d] [--limit]` lists them.

### Changed
- The package is `@contract-dev/cli` and the command is `contract-dev` (were both `contract.dev`). The dotted
  command never ran on Windows: PowerShell and cmd treat `.dev` as a file extension, find the POSIX shim npm
  writes next to the `.cmd` wrapper, and open it as a document. Install with `npm install -g @contract-dev/cli`
  or run `npx @contract-dev/cli <command>`. The `contract.dev` package is deprecated and gets no further releases.

- `metrics show` and `metrics export` say which window the server served when the plan narrowed it
  (Free reaches 90 days at a point a day since the 2026-10-06 app deploy; `all` stays paid).

### Fixed
- `status` and `monitors` read monitor states the way the app does. The server says `ok` / `breached` / `warming`;
  1.2.0 and 1.3.0 counted those as nothing, so a workspace with an open alert showed 0 healthy · 0 alerting.

## 1.3.0 — 2026-10-01

Needs the app deploy that lets a staff key name a workspace (`lib/apiAuth`, `lib/workspaceOverride`)
and lets an API key read the dashboard's data routes (every `/api/mainnet/*` route answers a key, with a
per-key limit of 120 requests a minute).

### Added
- Everything the dashboard shows, from the terminal. `<contract>` is an address or a watched contract's name:
  - `activity [<contract>] [--calls|--events|--transfers] [--failed] [--reads|--all] [--direct|--routed]` — the Activity tab.
  - `methods [<contract>]`, `methods <contract> <method> [--paths]` — calls per method; one method in full; the paths into it.
  - `flows [<contract>] [--in|--out] [--token]`, `counterparty <address>` — value in and out, by token and counterparty.
  - `users [<contract>] [--routes|--wallets]` — active wallets, how they arrive, the busiest.
  - `tvl [<contract>]`, `positions <contract>`, `holders <contract>` — value held and what it is made of.
  - `contracts show <contract>`, `contracts stats`, `dependencies <contract>`.
  - `tx <hash> [--trace] [--state]`, `address <0x…>`, `block <n>`, `wallet <0x…> [--approvals|--txs]`, `source <contract> [--out]`.
  - `--range 24h|7d|30d|90d` and `--chain` throughout; `--json` gives the full payload the dashboard renders.
- `--workspace <id|slug>` on any command, and `CONTRACT_DEV_WORKSPACE`: act on a named workspace instead of
  the one the credentials are bound to. The server honours it for contract.dev staff (a root admin on any
  workspace, hand-over staff on a workspace they belong to) and refuses any other key, so nothing changes for
  everyone else: the key still decides the workspace, and `workspace use` still logs in again.

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
