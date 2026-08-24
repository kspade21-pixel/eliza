# @elizaos/plugin-paper-trading

A wallet-free, deterministic spot paper-trading engine for AlphaApextrd.

## Safety boundary

This package is simulation-only. It has:

- no wallet dependency;
- no exchange SDK or order-routing adapter;
- fixed-host, read-only CoinGecko public market-data requests only;
- no credential or environment-variable reads;
- no transfers, swaps, live orders, margin, leverage, or shorting;
- no claim or guarantee of profitability.

Every trading result is labeled `PAPER`. Quotes may be explicitly supplied with provenance or fetched from the fixed read-only public source. Stale, future, mismatched, or
unapproved-symbol quotes fail closed.

## Default $20 policy

| Control | Limit |
|---|---:|
| Initial simulated cash | $20.00 |
| Maximum order | $2.00 |
| Maximum exposure per symbol | $5.00 |
| Maximum gross exposure | $10.00 |
| Minimum cash reserve | $10.00 |
| Daily-loss halt | $1.00 |
| Fee model | 10 bps |
| Slippage model | 20 bps |
| Maximum quote age | 5 minutes |
| Symbol allowlist | BTC, ETH |

Money uses integer USD micros and asset quantities use integer atomic units.
Fills are deterministic and retries require an idempotency key. Accepted and
rejected attempts are recorded in a SHA-256 hash-linked audit chain.

## Verification

```bash
bun run --cwd plugins/plugin-paper-trading test
bun run --cwd plugins/plugin-paper-trading typecheck
bun run --cwd plugins/plugin-paper-trading build
```

## Chat runtime integration

The owner-only `PAPER_TRADING` action supports:

- `operation=status` — read the simulated ledger and risk state;
- `operation=quote` — read a bounded public BTC/ETH quote;
- `operation=backtest` — run historical paper research without changing the ledger;
- `operation=buy` — deterministic simulated spot buy;
- `operation=sell` — deterministic simulated spot sell.

Buy and sell require a decimal quantity and idempotency key. They may use a fresh public quote or an explicitly supplied USD quote with source and ISO-8601 observation time. Quotes older than five minutes, future quotes, missing provenance, and symbols outside BTC/ETH are rejected. The `PAPER_TRADING_PORTFOLIO` provider labels all context as
simulation-only.

The runtime service atomically persists the simulated ledger, positions, audit chain, and idempotency receipts under Eliza's local state directory. Startup restores only versioned, hash-valid state and fails closed on corruption. Live execution remains out of scope.


## Public historical backtesting

The `backtest` operation downloads bounded, read-only daily BTC or ETH history
from the fixed CoinGecko public endpoint and runs a deterministic 5/20 moving
average research simulation.

Supported windows are 30, 90, 180, and 365 days. The simulation starts with
$20, limits each modeled allocation to $2, preserves a $10 reserve, remains
long-only, and models the same 10 bps fee and 20 bps slippage assumptions used
by the paper ledger.

Example chat request:

```text
Use PAPER_TRADING with operation backtest, symbol BTC, and days 90. Report the historical paper research only.
```

Backtest output includes the completed-bar as-of time, algorithm version, and a SHA-256 evidence hash covering symbol, source, window, policy, and normalized bars. It is research evidence, not a forecast, guarantee, or instruction to trade. It never writes to the persistent portfolio and cannot route orders,
wallet actions, transfers, or credentials.
