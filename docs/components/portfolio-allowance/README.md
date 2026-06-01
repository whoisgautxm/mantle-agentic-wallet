# Portfolio and Allowance Layer

Rank: 5

Priority: High

## Goal

Make the wallet understand real ERC20 assets, balances, decimals, allowances, approvals, and portfolio exposure.

## Current Project Fit

Today, MockDEX maintains an internal token ledger through `tokenBalance(address)`. That avoids ERC20 approval complexity, which was useful for the first demo. Real DEXs and lending protocols require ERC20 transfers and approvals.

## Real Problems It Solves

- Token decimals differ.
- Approval amounts can be unsafe.
- Protocols often require approval before swap/supply.
- A position can look small in raw token units but large in USD/MNT terms.
- The dashboard needs real token balances and exposure.
- Revoking allowances is part of operational safety.

## Integration Design

Add:

```text
agent/src/portfolio/
  erc20.ts
  registry.ts
  balances.ts
  allowances.ts
  valuation.ts
  types.ts
```

Token registry:

```ts
interface TokenInfo {
  chainId: number;
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  pricePair?: string;
  riskTier: "core" | "stable" | "volatile" | "experimental";
}
```

Allowance plan:

```ts
interface ApprovalPlan {
  token: `0x${string}`;
  spender: `0x${string}`;
  amount: bigint;
  mode: "exact" | "buffered" | "revoke";
}
```

## Approval Policy

Default rules:

- Prefer exact or bounded approvals.
- Reject unlimited approvals unless the spender is explicitly approved and the amount is justified.
- Track current allowance before asking for approval.
- Revoke stale allowances after strategy completion where possible.
- Prefer permit flows only after signature domain and nonce safety are implemented.

## ERC20 Compatibility Notes

The ERC20 standard defines a common token API for balances, transfers, and approvals. However, callers must handle tokens that return `false`, use unusual decimals, or behave differently from ideal implementations.

## Dashboard Implications

Add:

- token balances
- token values
- protocol exposures
- allowance table
- unsafe approval warnings
- revoke action queue for operator review

## Acceptance Criteria

- Reads ERC20 `balanceOf`, `decimals`, `symbol`, and `allowance`.
- Converts raw amounts safely using decimals.
- Risk engine can block trades based on exposure.
- Adapter can request approval plans before execution.
- Tests cover exact approval, missing approval, unlimited approval rejection, and revoke plan creation.

## Resources

- ERC20 standard: https://eips.ethereum.org/EIPS/eip-20
- ethereum.org ERC20 overview: https://ethereum.org/developers/docs/standards/tokens/erc-20/
- OpenZeppelin ERC20 docs: https://docs.openzeppelin.com/contracts/4.x/api/token/erc20
- ERC-2612 permit standard: https://eips.ethereum.org/EIPS/eip-2612
- Uniswap Permit2 allowance transfer: https://developers.uniswap.org/docs/protocols/permit2/concepts/allowance-transfer
