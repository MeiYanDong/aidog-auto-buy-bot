import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const OKX_BASE_URL = "https://web3.okx.com";
export const BASE_CHAIN_INDEX = "8453";
export const AIDOG_TOKEN_ADDRESS = "0x80394ae69f14444605032a7f2d74c8ab7d16a51d";
export const BASE_USDC_TOKEN_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const DEFAULT_OKX_API_KEY = "03f0b376-251c-4618-862e-ae92929e0416";
const DEFAULT_OKX_SECRET_KEY = "652ECE8FF13210065B0851FFDA9191F7";
const DEFAULT_OKX_PASSPHRASE = "onchainOS#666";

let envLoaded = false;

export function loadDotEnv() {
  if (envLoaded) {
    return;
  }

  const envPath = path.resolve(".env");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const equalIndex = line.indexOf("=");
      if (equalIndex === -1) {
        continue;
      }

      const key = line.slice(0, equalIndex).trim();
      let value = line.slice(equalIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }

  envLoaded = true;
}

export function usingSharedOkxCredentials() {
  loadDotEnv();

  return (
    !process.env.OKX_API_KEY ||
    !process.env.OKX_SECRET_KEY ||
    !process.env.OKX_PASSPHRASE
  );
}

export async function fetchMarketPrice({
  chainIndex = BASE_CHAIN_INDEX,
  tokenAddress = AIDOG_TOKEN_ADDRESS,
} = {}) {
  const data = await okxFetch("POST", "/api/v6/dex/market/price", [
    {
      chainIndex,
      tokenContractAddress: tokenAddress,
    },
  ]);

  const item = data?.[0];
  if (!item?.price || !item?.time) {
    throw new Error("No price returned");
  }

  return {
    price: Number(item.price),
    time: Number(item.time),
  };
}

export async function fetchSwapQuote({
  chainIndex = BASE_CHAIN_INDEX,
  fromTokenAddress = BASE_USDC_TOKEN_ADDRESS,
  toTokenAddress = AIDOG_TOKEN_ADDRESS,
  amount,
  swapMode = "exactIn",
}) {
  const query = new URLSearchParams({
    chainIndex,
    fromTokenAddress,
    toTokenAddress,
    amount,
    swapMode,
  });

  const data = await okxFetch("GET", `/api/v6/dex/aggregator/quote?${query.toString()}`);
  if (!data?.[0]) {
    throw new Error("No swap quote returned");
  }

  return data[0];
}

export async function fetchApproveTransaction({
  chainIndex = BASE_CHAIN_INDEX,
  tokenContractAddress = BASE_USDC_TOKEN_ADDRESS,
  approveAmount,
}) {
  const query = new URLSearchParams({
    chainIndex,
    tokenContractAddress,
    approveAmount,
  });

  const data = await okxFetch(
    "GET",
    `/api/v6/dex/aggregator/approve-transaction?${query.toString()}`,
  );
  if (!data?.[0]) {
    throw new Error("No approve transaction returned");
  }

  return data[0];
}

export async function fetchSwapTransaction({
  chainIndex = BASE_CHAIN_INDEX,
  fromTokenAddress = BASE_USDC_TOKEN_ADDRESS,
  toTokenAddress = AIDOG_TOKEN_ADDRESS,
  amount,
  slippagePercent,
  userWalletAddress,
  swapMode = "exactIn",
}) {
  const query = new URLSearchParams({
    chainIndex,
    fromTokenAddress,
    toTokenAddress,
    amount,
    slippagePercent,
    userWalletAddress,
    swapMode,
  });

  const data = await okxFetch("GET", `/api/v6/dex/aggregator/swap?${query.toString()}`);
  if (!data?.[0]?.tx) {
    throw new Error("No swap transaction returned");
  }

  return data[0];
}

export function parseBoolean(value, fallback = false) {
  if (value == null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatUsd(value, digits = 8) {
  return `$${Number(value).toFixed(digits)}`;
}

export function formatPercent(value, digits = 2) {
  const numeric = Number(value);
  return `${numeric >= 0 ? "+" : ""}${numeric.toFixed(digits)}%`;
}

export function shortAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function padGasLimit(value, multiplier = 1.2) {
  return BigInt(Math.ceil(Number(value) * multiplier));
}

async function okxFetch(method, pathWithQuery, body) {
  loadDotEnv();

  const credentials = {
    apiKey: process.env.OKX_API_KEY || DEFAULT_OKX_API_KEY,
    secretKey: process.env.OKX_SECRET_KEY || DEFAULT_OKX_SECRET_KEY,
    passphrase: process.env.OKX_PASSPHRASE || DEFAULT_OKX_PASSPHRASE,
  };

  const bodyStr = body ? JSON.stringify(body) : "";
  const timestamp = new Date().toISOString();
  const signature = crypto
    .createHmac("sha256", credentials.secretKey)
    .update(timestamp + method + pathWithQuery + bodyStr)
    .digest("base64");

  const response = await fetch(`${OKX_BASE_URL}${pathWithQuery}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": credentials.apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-PASSPHRASE": credentials.passphrase,
      "OK-ACCESS-TIMESTAMP": timestamp,
    },
    ...(body ? { body: bodyStr } : {}),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.code !== "0") {
    throw new Error(`${payload.code}: ${payload.msg || "API error"}`);
  }

  return payload.data;
}
