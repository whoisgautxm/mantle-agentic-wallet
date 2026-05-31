export function portfolioValueWei(mntWei: bigint, tokenWei: bigint, priceWei: bigint): bigint {
  return mntWei + (tokenWei * priceWei) / 10n ** 18n;
}

export function roiBps(currentWei: bigint, referenceWei: bigint): bigint {
  if (referenceWei === 0n) return 0n;
  return ((currentWei - referenceWei) * 10_000n) / referenceWei;
}
