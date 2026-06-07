// Quote-to-submit freshness (live-run report P1, section 10): the keeper moves the DEX/oracle price
// between quote, simulation, and inclusion, which caused OracleFloorTooLow reverts. Before submitting,
// reject a decision whose pinned observation block has drifted too far behind the chain head, so we
// re-observe rather than submit against a moved oracle floor.

export interface FreshnessInput {
  snapshotBlock: bigint; // block the decision was computed from (VaultState.blockNumber)
  headBlock: bigint; // current chain head just before submission
  maxDriftBlocks: bigint; // tolerance
}

export interface FreshnessResult {
  ok: boolean;
  driftBlocks: bigint;
  reason?: string;
}

export function checkSnapshotFreshness(input: FreshnessInput): FreshnessResult {
  const { snapshotBlock, headBlock, maxDriftBlocks } = input;
  const driftBlocks = headBlock > snapshotBlock ? headBlock - snapshotBlock : 0n;
  const ok = driftBlocks <= maxDriftBlocks;
  return {
    ok,
    driftBlocks,
    reason: ok
      ? undefined
      : `observation block ${snapshotBlock} is ${driftBlocks} blocks behind head ${headBlock} (max ${maxDriftBlocks})`,
  };
}
