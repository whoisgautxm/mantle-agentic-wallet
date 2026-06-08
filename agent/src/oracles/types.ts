type PriceSource = "mockdex" | "pyth";

export interface PriceSnapshot {
  pair: string;
  priceWei: bigint;
  source: PriceSource;
  updatedAt: bigint;
  stale: boolean;
  maxAgeSeconds: bigint;
  confidenceWei?: bigint;
  warnings?: string[];
}
