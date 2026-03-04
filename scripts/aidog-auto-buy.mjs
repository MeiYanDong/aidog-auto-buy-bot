import { ethers } from "ethers";
import {
  AIDOG_TOKEN_ADDRESS,
  BASE_CHAIN_INDEX,
  BASE_USDC_TOKEN_ADDRESS,
  fetchApproveTransaction,
  fetchMarketPrice,
  fetchSwapQuote,
  fetchSwapTransaction,
  formatPercent,
  formatUsd,
  loadDotEnv,
  padGasLimit,
  parseBoolean,
  shortAddress,
  sleep,
  usingSharedOkxCredentials,
} from "./lib/okx-onchainos.mjs";

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
];

loadDotEnv();

const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const BASE_PRIVATE_KEY = process.env.BASE_PRIVATE_KEY || "";
const CONFIGURED_WALLET_ADDRESS = process.env.BASE_WALLET_ADDRESS || "";
const BUY_THRESHOLD_USD = Number(process.env.BUY_THRESHOLD_USD || 0.004);
const BUY_AMOUNT_USDC = process.env.BUY_AMOUNT_USDC || "2";
const SLIPPAGE_PERCENT = process.env.SLIPPAGE_PERCENT || "1";
const MAX_PRICE_IMPACT_PERCENT = Number(process.env.MAX_PRICE_IMPACT_PERCENT || 5);
const MAX_TAX_RATE = Number(process.env.MAX_TAX_RATE || 0.05);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const BUY_ONCE = parseBoolean(process.env.BUY_ONCE, true);
const DRY_RUN = parseBoolean(process.env.DRY_RUN, true);
const MAX_SAMPLES = Number(process.env.MAX_SAMPLES || 0);

let previousPrice = null;
let samplesCollected = 0;
let hasTriggered = false;

const provider = new ethers.JsonRpcProvider(BASE_RPC_URL, Number(BASE_CHAIN_INDEX));
const signer = BASE_PRIVATE_KEY ? new ethers.Wallet(BASE_PRIVATE_KEY, provider) : null;
const walletAddress = resolveWalletAddress();
const erc20Interface = new ethers.Interface(ERC20_ABI);

process.on("SIGINT", () => {
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
    `Watching AIDOG on Base for ${formatUsd(BUY_THRESHOLD_USD, 6)} or below. Amount: ${BUY_AMOUNT_USDC} USDC. Wallet: ${shortAddress(walletAddress)}.`,
  );
  console.log(
    `${DRY_RUN ? "DRY_RUN is enabled, no transactions will be sent." : "Live trading is enabled."}`,
  );

  while (true) {
    const sample = await fetchMarketPrice();
    printPrice(sample);
    samplesCollected += 1;

    if (!hasTriggered && sample.price <= BUY_THRESHOLD_USD) {
      hasTriggered = true;

      try {
        await attemptBuy(sample.price);
        if (BUY_ONCE) {
          return;
        }
      } catch (error) {
        hasTriggered = false;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[${new Date().toLocaleTimeString()}] buy attempt failed: ${message}`);
      }
    }

    if (MAX_SAMPLES > 0 && samplesCollected >= MAX_SAMPLES) {
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function attemptBuy(triggerPrice) {
  const amountIn = ethers.parseUnits(BUY_AMOUNT_USDC, 6);

  const quote = await fetchSwapQuote({
    amount: amountIn.toString(),
    fromTokenAddress: BASE_USDC_TOKEN_ADDRESS,
    toTokenAddress: AIDOG_TOKEN_ADDRESS,
  });

  validateQuote(quote);

  const expectedAidog = ethers.formatUnits(
    quote.toTokenAmount,
    Number(quote.toToken.decimal),
  );
  const route = quote.dexRouterList
    ?.map((item) => item.dexProtocol?.dexName)
    .filter(Boolean)
    .join(" -> ");

  console.log(
    `[${new Date().toLocaleTimeString()}] trigger hit at ${formatUsd(triggerPrice)}. Quote: ${BUY_AMOUNT_USDC} USDC -> ${expectedAidog} AIDOG.`,
  );
  console.log(
    `Route: ${route || "n/a"} | price impact ${formatPercent(quote.priceImpactPercent)} | tax ${formatPercent(Number(quote.toToken.taxRate) * 100)}`,
  );

  if (DRY_RUN) {
    let needsApprovalText = "approval status unavailable";

    try {
      const approveInfo = await fetchApproveTransaction({
        approveAmount: amountIn.toString(),
        tokenContractAddress: BASE_USDC_TOKEN_ADDRESS,
      });
      const usdcBalance = await readErc20Uint256("balanceOf", [walletAddress]);
      const allowance = await readErc20Uint256("allowance", [
        walletAddress,
        approveInfo.dexContractAddress,
      ]);

      if (usdcBalance < amountIn) {
        console.log(
          `Wallet has only ${ethers.formatUnits(usdcBalance, 6)} USDC, so a live run would stop before swapping.`,
        );
      }

      needsApprovalText = allowance < amountIn ? "would approve USDC first" : "allowance already sufficient";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`Skipping on-chain balance checks in dry run: ${message}`);
    }

    console.log(
      `${needsApprovalText}; would send swap transaction next.`,
    );
    return;
  }

  if (!signer) {
    throw new Error("BASE_PRIVATE_KEY is required when DRY_RUN=false.");
  }

  const approveInfo = await fetchApproveTransaction({
    approveAmount: amountIn.toString(),
    tokenContractAddress: BASE_USDC_TOKEN_ADDRESS,
  });

  const usdcBalance = await readErc20Uint256("balanceOf", [walletAddress]);
  if (usdcBalance < amountIn) {
    throw new Error(
      `Insufficient USDC balance. Need ${BUY_AMOUNT_USDC}, have ${ethers.formatUnits(usdcBalance, 6)}.`,
    );
  }

  const allowance = await readErc20Uint256("allowance", [
    walletAddress,
    approveInfo.dexContractAddress,
  ]);
  const needsApproval = allowance < amountIn;

  if (needsApproval) {
    const approvalTx = await signer.sendTransaction({
      to: BASE_USDC_TOKEN_ADDRESS,
      data: approveInfo.data,
      gasLimit: padGasLimit(approveInfo.gasLimit),
    });

    console.log(`Approval sent: ${approvalTx.hash}`);
    await approvalTx.wait();
  }

  const swapResult = await fetchSwapTransaction({
    amount: amountIn.toString(),
    fromTokenAddress: BASE_USDC_TOKEN_ADDRESS,
    toTokenAddress: AIDOG_TOKEN_ADDRESS,
    slippagePercent: SLIPPAGE_PERCENT,
    userWalletAddress: walletAddress,
  });

  await provider.call({
    from: walletAddress,
    to: swapResult.tx.to,
    data: swapResult.tx.data,
    value: swapResult.tx.value,
  });

  const swapTx = await signer.sendTransaction({
    to: swapResult.tx.to,
    data: swapResult.tx.data,
    value: swapResult.tx.value,
    gasLimit: padGasLimit(swapResult.tx.gas),
  });

  console.log(`Swap sent: ${swapTx.hash}`);
  const receipt = await swapTx.wait();
  console.log(`Swap confirmed in block ${receipt.blockNumber}.`);
}

function printPrice(sample) {
  const timestamp = new Date(sample.time).toLocaleTimeString();
  const delta =
    previousPrice == null ? null : ((sample.price - previousPrice) / previousPrice) * 100;
  const deltaText = delta == null ? "n/a" : formatPercent(delta);

  console.log(
    `[${timestamp}] ${formatUsd(sample.price)} (${deltaText} vs last sample, target ${formatUsd(BUY_THRESHOLD_USD, 6)})`,
  );

  previousPrice = sample.price;
}

function validateQuote(quote) {
  if (quote.toToken.isHoneyPot || quote.fromToken.isHoneyPot) {
    throw new Error("Swap quote flagged a honeypot token.");
  }

  const priceImpact = Math.abs(Number(quote.priceImpactPercent));
  if (priceImpact > MAX_PRICE_IMPACT_PERCENT) {
    throw new Error(
      `Price impact ${formatPercent(priceImpact)} exceeds limit ${formatPercent(MAX_PRICE_IMPACT_PERCENT)}.`,
    );
  }

  const taxRate = Number(quote.toToken.taxRate);
  if (taxRate > MAX_TAX_RATE) {
    throw new Error(
      `Token tax rate ${formatPercent(taxRate * 100)} exceeds limit ${formatPercent(MAX_TAX_RATE * 100)}.`,
    );
  }
}

function resolveWalletAddress() {
  if (signer && CONFIGURED_WALLET_ADDRESS) {
    const normalizedConfigured = ethers.getAddress(CONFIGURED_WALLET_ADDRESS);
    if (signer.address !== normalizedConfigured) {
      throw new Error("BASE_WALLET_ADDRESS does not match BASE_PRIVATE_KEY.");
    }
  }

  if (signer) {
    return signer.address;
  }

  if (CONFIGURED_WALLET_ADDRESS) {
    return ethers.getAddress(CONFIGURED_WALLET_ADDRESS);
  }

  throw new Error("Set BASE_WALLET_ADDRESS for dry runs, or BASE_PRIVATE_KEY for live trading.");
}

async function readErc20Uint256(functionName, args) {
  const callData = erc20Interface.encodeFunctionData(functionName, args);
  const response = await rpcFetchWithRetry({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [
      {
        to: BASE_USDC_TOKEN_ADDRESS,
        data: callData,
      },
      "latest",
    ],
  });

  const payload = await response.json();
  if (payload.error) {
    throw new Error(payload.error.message || "RPC eth_call failed");
  }

  const [result] = erc20Interface.decodeFunctionResult(functionName, payload.result);
  return result;
}

async function rpcFetchWithRetry(body, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(BASE_RPC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      return response;
    }

    if (response.status !== 429 || attempt === retries) {
      throw new Error(`RPC HTTP ${response.status}`);
    }

    await sleep(500 * (attempt + 1));
  }
}
