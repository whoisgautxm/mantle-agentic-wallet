export interface PriceSnapshot {
  pair: string;
  priceWei: bigint;
  source: "mockdex";
  updatedAt: bigint;
  stale: boolean;
  maxAgeSeconds: bigint;
}
