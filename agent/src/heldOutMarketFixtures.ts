import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import type { MarketRegimeFixture, MultiRegimeFixture } from "./multiRegimeEval.js";

const PRICE_SCALE = 1_000_000n;
const BPS = 10_000n;

export interface HeldOutFixtureOptions {
  seed: number;
  devPaths: number;
  testPaths: number;
  ticks: number;
}

export interface HeldOutFixtureSet {
  development: MultiRegimeFixture;
  heldOut: MultiRegimeFixture;
}

type SyntheticFamily = "trend-up" | "trend-down" | "range" | "shock-recovery";

function createRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function integer(random: () => number, minimum: number, maximum: number): number {
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function formatPrice(price: bigint): string {
  const whole = price / PRICE_SCALE;
  const fraction = (price % PRICE_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function nextReturnBps(
  family: SyntheticFamily,
  random: () => number,
  tick: number,
  shockTick: number,
  price: bigint,
  anchor: bigint,
): number {
  if (family === "trend-up") return integer(random, 35, 115) + integer(random, -25, 25);
  if (family === "trend-down") return -integer(random, 35, 115) + integer(random, -25, 25);
  if (family === "shock-recovery") {
    if (tick === shockTick) return -integer(random, 1_400, 2_800);
    if (tick > shockTick) return integer(random, 100, 320) + integer(random, -50, 50);
    return integer(random, -55, 55);
  }

  const displacementBps = Number(((anchor - price) * BPS) / anchor);
  return Math.trunc(displacementBps / 3) + integer(random, -120, 120);
}

function generatePath(random: () => number, id: string, ticks: number): MarketRegimeFixture {
  const families: SyntheticFamily[] = ["trend-up", "trend-down", "range", "shock-recovery"];
  const family = families[integer(random, 0, families.length - 1)];
  const anchor = BigInt(integer(random, 1_500_000, 2_500_000));
  const shockTick = integer(random, 3, Math.max(3, ticks - 4));
  let price = anchor;
  const prices = [formatPrice(price)];

  for (let tick = 1; tick < ticks; tick += 1) {
    const changeBps = nextReturnBps(family, random, tick, shockTick, price, anchor);
    price = (price * BigInt(Math.max(1_000, 10_000 + changeBps))) / BPS;
    if (price < 100_000n) price = 100_000n;
    prices.push(formatPrice(price));
  }

  return {
    id,
    label: `Synthetic path ${id}`,
    description: "Seeded synthetic path reserved for strategy generalization evaluation.",
    prices,
  };
}

function fixture(name: string, regimes: MarketRegimeFixture[]): MultiRegimeFixture {
  return {
    version: 1,
    name,
    initialPortfolio: { mnt: "1", token: "0" },
    baseline: { buyMnt: "0.02" },
    costs: { swapFeeBps: 30, slippageBps: 20, gasMnt: "0.0002" },
    vaultLimits: { spendPerTxMnt: "0.1", dailySpendMnt: "1" },
    regimes,
  };
}

export function generateHeldOutFixtureSet(options: HeldOutFixtureOptions): HeldOutFixtureSet {
  if (!Number.isInteger(options.seed)) throw new Error("seed must be an integer");
  if (!Number.isInteger(options.devPaths) || options.devPaths < 1) throw new Error("devPaths must be positive");
  if (!Number.isInteger(options.testPaths) || options.testPaths < 1) throw new Error("testPaths must be positive");
  if (!Number.isInteger(options.ticks) || options.ticks < 8) throw new Error("ticks must be at least 8");

  const random = createRandom(options.seed);
  const development = Array.from({ length: options.devPaths }, (_, index) =>
    generatePath(random, `dev-${String(index + 1).padStart(3, "0")}`, options.ticks),
  );
  const heldOut = Array.from({ length: options.testPaths }, (_, index) =>
    generatePath(random, `test-${String(index + 1).padStart(3, "0")}`, options.ticks),
  );
  return {
    development: fixture(`Seeded development market paths (seed ${options.seed})`, development),
    heldOut: fixture(`Seeded held-out market paths (seed ${options.seed})`, heldOut),
  };
}

export async function writeHeldOutFixtureSet(
  fixtures: HeldOutFixtureSet,
  outputDirectory = path.join("evals", "generated"),
): Promise<{ developmentPath: string; heldOutPath: string }> {
  await mkdir(outputDirectory, { recursive: true });
  const developmentPath = path.join(outputDirectory, "market-paths-development.json");
  const heldOutPath = path.join(outputDirectory, "market-paths-held-out.json");
  await Promise.all([
    writeFile(developmentPath, `${JSON.stringify(fixtures.development, null, 2)}\n`, "utf8"),
    writeFile(heldOutPath, `${JSON.stringify(fixtures.heldOut, null, 2)}\n`, "utf8"),
  ]);
  return { developmentPath, heldOutPath };
}

function option(args: string[], name: string, fallback: number): number {
  const prefix = `${name}=`;
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  return raw === undefined ? fallback : Number(raw);
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outputDirectory = args.find((arg) => !arg.startsWith("--")) ?? path.join("evals", "generated");
  const options = {
    seed: option(args, "--seed", 20260607),
    devPaths: option(args, "--dev", 20),
    testPaths: option(args, "--test", 100),
    ticks: option(args, "--ticks", 14),
  };
  const paths = await writeHeldOutFixtureSet(generateHeldOutFixtureSet(options), outputDirectory);
  console.log(JSON.stringify({ options, ...paths }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[held-out-fixtures] failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
