# Mantle Autonomous Agent Wallet

Hackathon submission for the Mantle "Turing Test" 2026 — Agentic Wallets & Economy track.
An AI agent that custodies funds in a smart-contract wallet on Mantle and transacts autonomously
under hard on-chain safety limits, logging every decision on-chain.

## Stack
- contracts/ — Solidity ^0.8.24, Foundry (forge test, forge script). Target: Mantle Sepolia (chainId 5003).
- agent/ — TypeScript, Node 22, viem, @anthropic-ai/sdk, vitest.
- web/ — Next.js App Router dashboard, viem for reads.

## Non-negotiable rules
- Money-handling code (AgentVault.sol, agent/src/policy.ts) is TDD: failing test first, then code.
- NEVER hardcode private keys or API keys. Read from env. .env is gitignored.
- The agent must NEVER be able to move funds outside the contract's per-tx limit, daily limit,
  target allowlist, and pause switch. The client-side policy guard mirrors the contract but the
  contract is the source of truth.
- Every agent action emits AgentVault.AgentDecision(nonce, target, value, data, rationale).
- Prefer small, focused files. Match existing style. Commit after each green test.

## Commands
- Contracts: `cd contracts && forge test -vvv`
- Agent: `cd agent && npm test`
- Dashboard: `cd web && npm run dev`

## Codex
- Use `/codex:review` before committing contract changes.
- Use `/codex:adversarial-review --base main` before submission to pressure-test the security model.
