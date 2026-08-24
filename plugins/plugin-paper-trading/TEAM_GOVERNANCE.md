# AlphaApextrd bounded-team governance

This registry describes task-scoped roles, not persistent or always-on agents.
Teams exist only for an assigned issue, and automations run only on configured
repository or schedule triggers.

## Role registry and trigger

- Intake steward: turns an approved issue into acceptance criteria, boundaries,
  and required evidence.
- Specialist implementer: owns the bounded code, tests, and documentation.
- Independent verifier: inspects the final diff and runs fresh checks without
  repairing production code or inheriting the implementer's verdict.
- Safety reviewer: joins changes involving trading modes, market data,
  persistence, permissions, credentials, or external connections.
- Human approver: alone authorizes merge, deployment, credentials, or movement
  beyond paper research.

An issue enters a specialist team only through an explicit `ready-for-agent`
label or equivalent configured trigger. Its assignment records target files,
acceptance criteria, exclusions, and the terminal deliverable. Implementer and
verifier must be separate roles.

## Evidence and approvals

Verdicts are `Pass`, `Partial`, `Fail`, or `Inconclusive`. A pass needs
fresh checks mapped to every acceptance criterion. Code reading, an
implementer's claim, an input hash, or mechanical mergeability is not a pass.

Human approval is mandatory for merge, deployment, secrets or permission
changes, live-provider enablement, live trading, transfers, and destructive
cleanup. Paper research fails closed when trading mode is ambiguous.

## Closure and automation capacity

A team closes when its scoped PR is merged, rejected, superseded, or explicitly
stopped. It publishes one concise receipt and retires; it does not remain active
or monitor indefinitely. Stale branches are reported and never auto-deleted.

Capacity is bounded: cancel superseded checks, allow at most one active
implementation per issue, serialize jobs sharing state or providers, retry a
classified transient failure once, and deduplicate repeated failures. Queue
excess work rather than dropping checks or weakening verification.
