# Smart Account Modules

Rank: 10

Priority: Medium

## Goal

Explore whether `AgentVault` should remain a custom wallet, become a Safe module/guard, or evolve toward ERC-4337 account abstraction.

This is highly relevant to "agentic wallets," but it should come after the risk, adapter, oracle, simulation, and portfolio layers. Otherwise, smart-account complexity will distract from the core benchmark.

## Current Project Fit

`AgentVault` is already a minimal smart account:

- human owner
- agent session key
- target allowlist
- spend limits
- pause switch
- execution event log

The next production-like step is not necessarily replacing it. It may be better to wrap or port its policy into known wallet module systems.

## Option A: Keep Custom AgentVault

Best for hackathon speed and clarity.

Pros:

- simple
- easy to audit
- already deployed
- easy to explain

Cons:

- not a standard wallet
- no ecosystem module tooling
- custom recovery/governance patterns

## Option B: Safe Module or Guard

Safe modules can automate actions and custom transaction logic while operating alongside Safe's multisig. Safe guards can add transaction restrictions before/after execution.

How it maps:

- current `agent` key -> module executor
- `allowedTarget` -> guard/module whitelist
- daily/per-tx limits -> module policy
- owner pause -> Safe owner threshold action
- `AgentDecision` -> module event

## Option C: ERC-4337 Smart Account

ERC-4337 introduces `UserOperation`, bundlers, EntryPoint, and optional Paymasters. It can support programmable wallets, flexible signatures, gas sponsorship, and batched flows.

How it maps:

- AI creates signed/user-approved intents.
- Bundler submits UserOperation.
- Smart account validates policy.
- Paymaster can sponsor gas under conditions.

## Recommended Path

1. Keep `AgentVault` for current demo.
2. Add function-selector allowlists and richer on-chain events.
3. Create a research prototype Safe module that mirrors `AgentVault.execute`.
4. Only explore ERC-4337 after the protocol/risk/oracle stack is stable.

## Acceptance Criteria

- A Safe module prototype can enforce target and function allowlists.
- The module emits the same decision metadata as `AgentVault`.
- Recovery/disable path is documented and tested.
- ERC-4337 is not used for live funds until bundler/paymaster support on target chain is verified.

## Resources

- Safe modules: https://docs.safe.global/advanced/smart-account-modules
- Safe guards: https://docs.safe.global/advanced/smart-account-guards
- ERC-4337 overview: https://docs.erc4337.io/core-standards/erc-4337
- ERC-4337 docs home: https://docs.erc4337.io/
