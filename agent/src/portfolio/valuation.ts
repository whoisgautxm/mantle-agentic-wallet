function scale10(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("invalid token decimals");
  return 10n ** BigInt(decimals);
}

export function tokenValueWei(balanceRaw: bigint, tokenPriceWei: bigint, tokenDecimals: number): bigint {
  return (balanceRaw * tokenPriceWei) / scale10(tokenDecimals);
}

export function exposureBps(positionValueWei: bigint, portfolioValueWei: bigint): bigint {
  if (portfolioValueWei <= 0n) return 0n;
  return (positionValueWei * 10_000n) / portfolioValueWei;
}
