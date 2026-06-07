# Guarded Execution Security Review

**Date:** June 7, 2026
**Scope:** `AgentVault.executeGuarded`, MockDEX ERC20 migration, agent execution wiring, Merchant Moe fork simulation, and dashboard readiness.

## Review Result

### High: Legacy execution could bypass the output guard

**Status:** Fixed.

The first implementation left `AgentVault.execute` callable for the same allowlisted trading venue. A compromised or buggy agent could skip `executeGuarded` entirely. The vault now has an owner-controlled `guardedTarget` mapping. Legacy execution reverts with `GuardedExecutionRequired` for those targets, while guarded execution remains available. Deployment marks MockDEX as guard-required, and Merchant Moe fork fixtures mark LBRouter as guard-required.

The red-team Forge test proves a direct legacy bypass attempt preserves vault balance, token balance, spend accounting, and nonce.

### Medium: Minimum output is caller-selected

**Status:** Accepted and documented.

The vault enforces the supplied `minOut` but does not derive it from an on-chain oracle. The normal agent path computes the floor from quote and slippage policy, but a fully compromised agent key can submit a very low positive floor. This implementation provides hard settlement enforcement, not oracle-authenticated intent. `SECURITY.md` states this boundary explicitly.

### Low: Token balance semantics are protocol-dependent

**Status:** Accepted for the hackathon scope.

The generic guard trusts ERC20-compatible `balanceOf` behavior. Fee-on-transfer, rebasing, or adversarial tokens need adapter-specific handling and output-asset governance before production use.

## Verification Evidence

- Forge tests cover successful ERC20 output, insufficient output rollback, zero minimum rejection, native output, existing limits, reentrancy, and legacy bypass prevention.
- Agent tests prove MockDEX and Merchant Moe trades encode `executeGuarded` with output asset and minimum output.
- Mantle Sepolia legacy execution was blocked for the guard-required MockDEX. Guarded transaction `0xa85b0591c8796d21e36a6a2dc2b27899c7e7b88841acee0dbfbb488692d0ab27` emitted ERC20 `Transfer`, `Bought`, `AgentDecision`, and `AgentGuardedDecision`, then matched expected vault accounting.
- Merchant Moe passed guarded simulation and fork-local execution at Mantle block `96340798`; the adversarial suite passed `5/5` at block `96340791` with zero unsafe swap submissions.
- Dashboard RPC status reads the real MockToken balance and guard-required configuration.
