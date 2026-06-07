import type { VaultState } from "./types.js";

export function portfolioValueWei(mntWei: bigint, tokenWei: bigint, priceWei: bigint): bigint {
  return mntWei + (tokenWei * priceWei) / 10n ** 18n;
}

export function roiBps(currentWei: bigint, referenceWei: bigint): bigint {
  if (referenceWei === 0n) return 0n;
  return ((currentWei - referenceWei) * 10_000n) / referenceWei;
}

export interface PortfolioSnapshot {
  mntBalanceWei: bigint;
  tokenBalanceWei: bigint;
  priceWei: bigint;
  tokenValueWei: bigint;
  portfolioValueWei: bigint;
  referenceValueWei: bigint;
  roiBps: bigint;
}

export function portfolioSnapshot(state: VaultState, referenceValueWei?: bigint): PortfolioSnapshot {
  const tokenValueWei = (state.tokenBalanceWei * state.priceWei) / 10n ** 18n;
  const value = state.balanceWei + tokenValueWei;
  const reference = referenceValueWei && referenceValueWei > 0n ? referenceValueWei : value;
  return {
    mntBalanceWei: state.balanceWei,
    tokenBalanceWei: state.tokenBalanceWei,
    priceWei: state.priceWei,
    tokenValueWei,
    portfolioValueWei: value,
    referenceValueWei: reference,
    roiBps: roiBps(value, reference),
  };
}
