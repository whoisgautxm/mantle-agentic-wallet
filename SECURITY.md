# Security Model

This project is a hackathon prototype, not an audited production wallet. It separates hard on-chain enforcement from off-chain preflight checks so reviewers can see which failures are prevented by the vault itself.

## Enforcement Boundary

| Protection | Enforcement | Prevents |
|---|---|---|
| Agent authorization | On-chain | Non-agent accounts executing vault actions |
| Owner pause and agent rotation | On-chain | Continued execution after an incident |
| Target allowlist | On-chain | Calls to venues the owner did not approve |
| Guard-required targets | On-chain | Trading venues bypassing `executeGuarded` through legacy `execute` |
| Per-transaction and rolling daily value limits | On-chain | Unbounded native-token outflow |
| Positive minimum output | On-chain | Zero-floor guarded calls |
| Output balance delta | On-chain | An allowlisted call delivering less than the declared `minOut` |
| Reentrancy lock | On-chain | Nested vault execution during an external call |
| Oracle freshness and quote deviation | Off-chain preflight | Trading against stale or manipulated reference data |
| Position and trade-value limits | Off-chain preflight | Excessive portfolio concentration |
| Calldata selector policy | Off-chain preflight | Unexpected protocol methods |
| Transaction simulation | Off-chain preflight | Calls expected to revert |
| Allowance classification | Off-chain preflight | Excessive or unbounded ERC20 approvals |

## Trust Assumptions

- The human owner correctly configures allowlisted and guard-required targets.
- The agent key remains scoped but can still choose calldata, output asset, and a positive `minOut`.
- Allowlisted protocols and ERC20 `balanceOf` implementations behave according to their documented interfaces.
- RPC, oracle, and quote sources are available and correctly configured for off-chain checks.

## Known Limitations

- `executeGuarded` enforces the caller-declared floor; it does not independently derive a fair price from an oracle. A fully compromised agent key can choose an unreasonably low positive floor. Oracle deviation and floor selection therefore remain off-chain policy.
- Legacy `execute` remains available for owner-approved non-trading setup calls. Every trading venue must also be marked `guardedTarget`.
- Native output is supported only when the call sends zero native value, which covers token-to-MNT sells without an ambiguous balance delta.
- Unusual fee-on-transfer, rebasing, or adversarial token balance implementations require protocol-specific review.
- `MockToken` grants its MockDEX controller mint/burn authority and is demo infrastructure, not a production asset.

## Incident Response

The owner should pause both vaults, rotate agent keys, revoke protocol allowances, and withdraw funds if a key, RPC, oracle, or allowlisted protocol is suspected to be compromised.
