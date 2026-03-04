import {
  fetchMarketPrice,
  formatPercent,
  formatUsd,
  loadDotEnv,
  sleep,
  usingSharedOkxCredentials,
} from "./lib/okx-onchainos.mjs";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const MAX_SAMPLES = Number(process.env.MAX_SAMPLES || 0);

loadDotEnv();

let previousPrice = null;
let stopped = false;
let samplesCollected = 0;

process.on("SIGINT", () => {
  stopped = true;
  process.stdout.write("\nStopped.\n");
  process.exit(0);
});

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  if (usingSharedOkxCredentials()) {
    console.log(
      "Using OKX shared test credentials. Set OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE in .env for stable usage.",
    );
  }

  console.log(
    `Monitoring AIDOG on Base every ${Math.round(POLL_INTERVAL_MS / 1000)}s. Press Ctrl+C to stop.`,
  );

  while (!stopped) {
    try {
      const sample = await fetchPrice();
      printPrice(sample);
      samplesCollected += 1;
      if (MAX_SAMPLES > 0 && samplesCollected >= MAX_SAMPLES) {
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${new Date().toLocaleTimeString()}] request failed: ${message}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function fetchPrice() {
  return fetchMarketPrice();
}

function printPrice(sample) {
  const timestamp = new Date(sample.time).toLocaleTimeString();
  const delta =
    previousPrice == null ? null : ((sample.price - previousPrice) / previousPrice) * 100;
  const deltaText = delta == null ? "n/a" : formatPercent(delta);

  console.log(`[${timestamp}] ${formatUsd(sample.price)} (${deltaText} vs last sample)`);

  previousPrice = sample.price;
}
