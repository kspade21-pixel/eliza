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
- `operation=report` — read performance, audit-chain integrity, and explicit risk alerts without mutating the ledger;
- `operation=quote` — read a bounded public BTC/ETH quote;
- `operation=backtest` — run historical paper research without changing the ledger;
- `operation=buy` — deterministic simulated spot buy;
- `operation=sell` — deterministic simulated spot sell.

Buy and sell require a decimal quantity and idempotency key. They may use a fresh public quote or an explicitly supplied USD quote with source and ISO-8601 observation time. Quotes older than five minutes, future quotes, missing provenance, and symbols outside BTC/ETH are rejected. The `PAPER_TRADING_PORTFOLIO` provider labels all context as
simulation-only.

The runtime service atomically persists the simulated ledger, positions, audit chain, and idempotency receipts under Eliza's local state directory. Startup restores only versioned, hash-valid state and fails closed on corruption. Live execution remains out of scope.


## Public historical backtesting

The `backtest` operation downloads bounded, read-only daily BTC or ETH
observations from the fixed CoinGecko public endpoint and runs a deterministic
5/20 moving-average research simulation. Signals use prior observations and
execution is modeled at the next observation price; the source does not prove
that an observation is a market-open price.

Supported windows are 30, 90, 180, and 365 days. The simulation starts with
$20, limits each modeled allocation to $2, preserves a $10 reserve, remains
long-only, and separates fee, full spread, and market-impact assumptions. The
base scenario uses the requested policy inputs (defaults: 10/10/10 bps);
optimistic uses 0.5x and stress uses 2.5x those inputs. All are explicitly
illustrative sensitivity assumptions, not observed fills or worst-case bounds.
No venue execution basis is observed, so output prohibits profitability ranking.

Example chat request:

```text
Use PAPER_TRADING with operation backtest, symbol BTC, and days 90. Report the historical paper research only.
```

Output compares cash and same-interval costed buy-and-hold benchmarks. It reports
mark-to-market terminal equity and hypothetical liquidation value; net
comparisons use liquidation value. It also reports decision-bar and round-trip
warnings, coverage/gap metrics, and a versioned run manifest with retrieval and
dataset as-of provenance where available.

Strategy and buy-and-hold maximum drawdown use the same liquidation-adjusted
path convention: at each observation, an open position is hypothetically closed
using that scenario's fee, half-spread, and market-impact assumptions. This
keeps benchmark drawdown comparable with terminal liquidation value, but remains
an illustrative model rather than venue evidence.

The SHA-256 value is only a reproducible content/input hash. Retrieval time is
recorded in the manifest but deliberately excluded from this hash, so identical
normalized bars and assumptions hash identically across retrievals. The hash is
not evidence that the
data, model, assumptions, or result are correct. Output is labeled
`UNVERIFIED RESEARCH` and is not a forecast, guarantee, validation, or
instruction to trade. Backtests never write to the persistent portfolio and
cannot route orders, wallet actions, transfers, or credentials.


## Launch-readiness dry-run framework

The exported launch-readiness API creates an immutable, SHA-256-bound
`PAPER_DRY_RUN` plan by evaluating a proposed paper order against an isolated
copy of the existing ledger. It reuses the engine's current risk checks while
leaving cash, positions, audit receipts, idempotency state, and persistent state
unchanged.

An optional short-lived approval intent may be bound to the exact plan hash.
That intent approves review of a simulation plan only. The concrete
`NoOpExecutionAdapter` always returns `executed: false`; even a valid bound
intent terminates with `LIVE_EXECUTION_UNAVAILABLE_BY_DESIGN`.

This framework contains no authenticated trading endpoint, signing capability,
wallet, credential lookup, transfer path, deployment switch, or live execution
feature flag. Profitability is neither promised nor inferred.
