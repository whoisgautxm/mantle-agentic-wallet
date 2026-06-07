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
| Oracle-bound minimum output | On-chain (opt-in) | A compromised agent declaring a `minOut` far below the oracle-fair price |
| Reentrancy lock | On-chain | Nested vault execution during an external call |
| Oracle freshness and quote deviation | Off-chain preflight | Trading against stale or manipulated reference data |
| Position and trade-value limits | Off-chain preflight | Excessive portfolio concentration |
| Calldata selector policy | Off-chain preflight | Unexpected protocol methods |
| Transaction simulation | Off-chain preflight | Calls expected to revert |
| Allowance classification | Off-chain preflight | Excessive or unbounded ERC20 approvals |

## Trust Assumptions

- The human owner correctly configures allowlisted and guard-required targets.
- The agent key remains scoped; its declared `minOut` is additionally floored on-chain against the owner-configured oracle, so it cannot settle a guarded trade far below oracle-fair value.
- The owner configures an honest price oracle and keeps it reasonably in sync with the execution venue; the deviation tolerance (`maxOracleDeviationBps`) absorbs normal slippage.
- Allowlisted protocols and ERC20 `balanceOf` implementations behave according to their documented interfaces.
- RPC, oracle, and quote sources are available and correctly configured for off-chain checks.

## Known Limitations

- `executeGuarded` now binds the caller-declared floor to an owner-configured on-chain oracle (`setOracle`): the declared `minOut` must be at least the oracle-fair output minus `maxOracleDeviationBps`, so a compromised agent can no longer settle a trade far below fair value. The residual trust is that the owner configures an honest oracle and keeps it in sync; oracle integrity itself is out of scope for the vault. When no oracle is configured the vault falls back to the caller-declared floor only.
- Legacy `execute` remains available for owner-approved non-trading setup calls. Every trading venue must also be marked `guardedTarget`.
- Native output is supported only when the call sends zero native value, which covers token-to-MNT sells without an ambiguous balance delta.
- Unusual fee-on-transfer, rebasing, or adversarial token balance implementations require protocol-specific review.
- `MockToken` grants its MockDEX controller mint/burn authority and is demo infrastructure, not a production asset.

## Incident Response

The owner should pause both vaults, rotate agent keys, revoke protocol allowances, and withdraw funds if a key, RPC, oracle, or allowlisted protocol is suspected to be compromised.
