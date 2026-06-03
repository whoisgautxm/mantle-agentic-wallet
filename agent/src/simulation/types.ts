export interface SimulationResult {
  ok: boolean;
  gasEstimate?: bigint;
  returnData?: `0x${string}`;
  reason?: string;
  revertReason?: string;
  warnings?: string[];
}
