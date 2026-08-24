# @elizaos/plugin-paper-trading

A wallet-free, deterministic spot paper-trading engine for AlphaApextrd.

## Safety boundary

This package is simulation-only. It has:

- no wallet dependency;
- no exchange SDK or network adapter;
- no credential or environment-variable reads;
- no transfers, swaps, live orders, margin, leverage, or shorting;
- no claim or guarantee of profitability.

Every result is labeled `PAPER`. Quotes must be supplied with a symbol, source,
observation time, and positive fixed-point price. Stale, future, mismatched, or
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
| Maximum quote age | 60 seconds |
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
- `operation=buy` — deterministic simulated spot buy;
- `operation=sell` — deterministic simulated spot sell.

Buy and sell require an explicit decimal quantity, decimal USD quote, quote
source, ISO-8601 observation time, and idempotency key. Quotes older than 60
seconds, future quotes, missing provenance, and symbols outside BTC/ETH are
rejected. The `PAPER_TRADING_PORTFOLIO` provider labels all context as
simulation-only.

The runtime service is intentionally in-memory in this release. Restarting Eliza
resets the simulated ledger to $20 and clears its audit chain. Durable storage
and read-only public market-data ingestion require separate reviewed changes.
Live execution remains out of scope.
