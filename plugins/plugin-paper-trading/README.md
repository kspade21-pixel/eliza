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
unapproved-symbol quotes fail closed. Custom risk policies must set
`maxQuoteAgeMs` to a positive safe integer in milliseconds; non-finite,
fractional, zero, and negative values fail during engine construction.
Direct engine orders likewise require non-negative safe-integer millisecond
values for both the requested and observed quote timestamps. Invalid timestamps
fail closed before quote-age arithmetic; rejected attempts use a deterministic
finite audit timestamp so exported state remains restart-safe.

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

The runtime service atomically persists the simulated ledger, positions, audit chain, and idempotency receipts under Eliza's local state directory. State schema v2 binds cash, realized P&L, halt status, positions, audit receipts, and the normalized risk policy into a deterministic `stateSha256` commitment. Startup rejects checksum or policy mismatches before restoring the ledger. Restored audit receipts are runtime-validated before idempotency indexes are rebuilt. The validator requires the exact `PAPER` mode, known receipt fields and reason codes, canonical integer encodings, valid sides and symbols, accepted/rejected field shapes, safe timestamps, and SHA-256 fields. It replays every accepted fill and every rejection that can be reconstructed from schema v2, re-enforcing execution risk, no-short inventory, cash, positions, realized P&L, and halt state. Quote-mismatch, missing-provenance, invalid-timestamp, and stale-quote reasons depend on original quote fields that v2 does not persist; those receipts are instead constrained to the correct pre-risk state and must remain ledger-nonmutating. The unkeyed hashes detect inconsistency but do not authenticate who produced the file.

Legacy v1 state is intentionally not auto-migrated because it did not commit every persisted field. Operators must archive the old paper-state file for audit, remove it from the active state path, and start a new $20 simulated ledger. The SHA-256 commitment detects inconsistent contents but is unkeyed and does not prove who created or modified a file. Live execution remains out of scope.


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

## Pinned walk-forward and out-of-sample evaluation

The exported `runPaperWalkForwardEvaluation` API adds a strict evaluation
protocol for fixed strategy configurations. Callers must first calculate and
persist the exact normalized dataset checksum with
`hashPublicHistoricalDataset`, then supply that checksum as
`expectedDatasetSha256`. Any changed price, timestamp, symbol, source, or
requested window fails closed before evaluation, as does an observation dated
after its declared retrieval time. Inputs are snapshotted once and limited to
2,000 strictly chronological positive-price observations.

Evaluation protocols are also limited to `MAX_WALK_FORWARD_FOLDS` (currently
128). The ceiling is checked before any fold backtest begins; a split requiring
more folds fails closed with `WALK_FORWARD_TOO_MANY_FOLDS`. Callers that need a
longer development range must increase `validationBars` or reduce the input
range, then precommit the revised configuration before evaluation.

Before a run, callers must also calculate and persist the configuration
commitment with `hashPaperWalkForwardConfiguration`. The run rejects a policy or
split that does not match `expectedConfigurationSha256`. This evaluator is
deliberately fixed to the existing 5/20 moving-average algorithm so its nested
backtest manifests remain exact; friction and portfolio assumptions may be
pinned, but the signal windows may not be changed through this API.

The protocol reserves the final observations as an untouched out-of-sample
holdout. Before that holdout is evaluated, the API runs non-overlapping
validation windows against an expanding training prefix. Each validation and
holdout window receives only the prior slow-window observations as signal
warmup, starts with fresh simulated cash, and executes only within its declared
index range. The API performs no parameter search, fitting, ranking, or
configuration selection.

This API is stateless: it proves that one run used the supplied precommitted
configuration and evaluated the holdout after its development folds, but it
cannot prevent an external caller from creating a different commitment and
starting a separate study. Consumers must archive the first commitment and
result and treat every different hash as a distinct evaluation rather than
retuning against an already-seen holdout.

The configuration records fee, full spread, slippage, and liquidity assumptions
separately. Slippage and liquidity are added into the existing backtest engine's
market-impact field because that engine applies those linear basis-point costs
together. Every fold and the final holdout retain the optimistic, base, and
stress scenarios plus cash and costed buy-and-hold benchmarks. Dataset,
configuration, individual backtest input, and complete evaluation checksums are
returned, and the complete result is deeply frozen.

These checksums establish reproducibility only. They do not authenticate a data
publisher or prove that public observations, assumptions, or modeled results
are correct. The API is paper research only and has no service, ledger, wallet,
credential, transfer, or order-routing access.
