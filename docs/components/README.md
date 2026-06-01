# Component Roadmap: Real Protocols and Real DeFi Problems

Research date: 2026-06-01

This roadmap ranks the components that would move the current Mantle Human-vs-AI trading wallet from a self-contained MockDEX demo toward a credible autonomous DeFi wallet benchmark.

The ranking is based on four factors:

- Relevance: How strongly the component supports the hackathon story and real DeFi usage.
- Technical necessity: Whether later components depend on it.
- Demo impact: Whether judges/users will immediately understand the improvement.
- Implementation risk: Lower-risk, high-leverage work ranks earlier.

## Current Baseline

The current project already has:

- `AgentVault`: guarded smart-contract wallet with allowlist, spend limits, pause switch, and on-chain `AgentDecision` events.
- `MockDEX`: internal-ledger venue with `PriceSet`, `Bought`, and `Sold` events.
- `agent`: OpenAI/Anthropic decision runner, keeper, baseline DCA runner, policy checks, and viem reads/writes.
- `web`: dashboard that reconstructs price, trades, and decision feeds from chain logs.
- Mantle Sepolia deployment through Alchemy RPC.

## Ranked Components

| Rank | Component | Priority | Why it ranks here |
| --- | --- | --- | --- |
| 1 | [Risk Engine](risk-engine/README.md) | Must-have | Real DeFi agents fail first at risk boundaries, not model creativity. This expands current `policy.ts` into slippage, oracle, exposure, daily loss, and circuit-breaker checks. |
| 2 | [Protocol Adapter Layer](protocol-adapters/README.md) | Must-have | Replaces hardcoded MockDEX assumptions with a stable interface for MockDEX, Merchant Moe, Uniswap-like routers, and future venues. |
| 3 | [Oracle Router](oracle-router/README.md) | Must-have | Moves price inputs from owner-set keeper prices toward Pyth/Chainlink-style oracle validation, staleness checks, and DEX quote deviation checks. |
| 4 | [Execution Simulation](execution-simulation/README.md) | Must-have | Prevents doomed or unsafe transactions by simulating vault execution, estimating gas, and validating quote/min-output before `submitExecute`. |
| 5 | [Portfolio and Allowance Layer](portfolio-allowance/README.md) | High | Real protocols require ERC20 balances, decimals, approvals, revocation, and exposure accounting. |
| 6 | [Lending and Yield Adapters](lending-adapters/README.md) | High | Adds real DeFi problems beyond swapping: collateral health, utilization, liquidation risk, supply caps, and borrow constraints. |
| 7 | [Evals and Tracing](evals-tracing/README.md) | High | Turns the AI wallet into a benchmark. Tracks decision quality, policy obedience, and regressions across prompts/models. |
| 8 | [Dashboard Analytics](dashboard-analytics/README.md) | Medium-high | Makes real protocol behavior legible: oracle status, risk flags, protocol cards, realized/unrealized PnL, and tx replay. |
| 9 | [Monitoring and Alerting](monitoring-alerting/README.md) | Medium | Operationalizes the agent with alerts for pauses, failed simulations, RPC issues, drawdown, and unexpected allowances. |
| 10 | [Smart Account Modules](smart-account-modules/README.md) | Medium | Safe modules and ERC-4337 make the wallet more production-like, but they add complexity after the core risk/protocol layer is stable. |
| 11 | [Demo Orchestrator](demo-orchestrator/README.md) | Medium | Removes process mistakes by running exactly one keeper, one AI runner, one baseline, and one dashboard with clean health checks. |

## Recommended Build Order

Phase 1: Safety and abstraction

1. Risk Engine v1
2. Protocol Adapter interface
3. MockDEX adapter migration
4. Execution simulation for current vault calls

Phase 2: Real market data

1. Oracle Router with mock + Pyth-compatible interface
2. DEX quote deviation checks
3. Dashboard oracle/risk panels

Phase 3: Real protocol adapters

1. Merchant Moe read-only/quote adapter
2. Mainnet-fork simulation adapter before any live execution
3. ERC20 portfolio and allowance management
4. Optional lending adapter for Lendle/INIT read-only risk views

Phase 4: Benchmarking and operations

1. OpenAI trace/eval harness
2. Monitoring alerts
3. Demo orchestrator
4. Smart-account module research prototype

## Architecture Direction

```text
OpenAI decision
    |
    v
Decision parser
    |
    v
Protocol adapter registry ---- Oracle router ---- Portfolio layer
    |                              |                    |
    v                              v                    v
Execution plan -------------- Risk engine -------- Simulation engine
    |
    v
AgentVault.execute(...)
    |
    v
On-chain events -> dashboard analytics -> eval/trace dataset
```

## Cross-Cutting Rules

- The model should never author raw calldata. Keep calldata generation inside adapters.
- The vault remains the final source of truth for hard limits.
- Add new protocol power only when there is an equal or stronger risk check.
- Treat Sepolia as the safe live demo network; use mainnet forks for real protocol simulations before real mainnet execution.
- Do not commit private keys, RPC keys, API keys, or funded-wallet secrets.

## Shared Resources

- Mantle Sepolia RPC details: https://www.alchemy.com/rpc/mantle-sepolia
- Merchant Moe docs: https://docs.merchantmoe.com/
- Merchant Moe contracts: https://docs.merchantmoe.com/resources/contracts
- Pyth EVM price feeds: https://docs.pyth.network/price-feeds/core/use-real-time-data/pull-integration/evm
- Chainlink Data Feeds: https://docs.chain.link/data-feeds
- viem simulateContract: https://viem.sh/docs/contract/simulateContract
- OpenAI agent evals: https://platform.openai.com/docs/guides/agent-evals
- OpenAI Agents SDK tracing: https://openai.github.io/openai-agents-js/guides/tracing/
- Safe modules: https://docs.safe.global/advanced/smart-account-modules
- ERC-4337 docs: https://docs.erc4337.io/core-standards/erc-4337
