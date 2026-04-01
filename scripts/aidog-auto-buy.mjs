import fs from "node:fs";
import path from "node:path";
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
  loadDotEnv,
  parseBoolean,
  shortAddress,
  sleep,
  usingSharedOkxCredentials,
} from "./lib/okx-onchainos.mjs";
import {
  createLogger,
  ensureDirectory,
  getTimeZoneParts,
  getWeekTimeZoneInfo,
  loadJsonFile,
  saveJsonFile,
} from "./lib/runtime.mjs";
import { createFeishuNotifier } from "./lib/feishu-notifier.mjs";
import {
  mergeTradeSnapshotWithRecoveredAmounts,
  recoverTradeAmounts,
} from "./lib/trade-recovery.mjs";
import {
  clearDailyDcaSkip,
  hasHandledDailyDcaForDay,
  normalizeDailyDcaState,
  rememberDailyDcaGuardFailure,
  shouldPersistDailyDcaGuardFailure,
} from "./lib/daily-dca-state.mjs";

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
];

loadDotEnv();

const CONFIG = buildConfig();
const STATE_FILE = path.resolve(process.env.STATE_FILE || "data/state/aidog-bot-state.json");
const LOG_FILE = path.resolve(process.env.LOG_FILE || "data/logs/aidog-bot.log");
const TRADE_LOG_FILE = path.resolve(
  process.env.TRADE_LOG_FILE || "data/logs/aidog-trades.jsonl",
);
const LOCK_FILE = path.resolve(process.env.LOCK_FILE || "data/state/aidog-bot.lock");

ensureDirectory(path.dirname(STATE_FILE));
ensureDirectory(path.dirname(LOG_FILE));
ensureDirectory(path.dirname(TRADE_LOG_FILE));
ensureDirectory(path.dirname(LOCK_FILE));

const logger = createLogger({
  logFile: LOG_FILE,
  tradeLogFile: TRADE_LOG_FILE,
});
const notifier = createFeishuNotifier(
  {
    webhookUrl: process.env.FEISHU_WEBHOOK_URL || "",
    secret: process.env.FEISHU_SECRET || "",
    botName: process.env.BOT_NAME || "AIDOG Bot",
    isDryRun: CONFIG.dryRun,
    notificationCooldownMs: Number(process.env.FEISHU_NOTIFY_COOLDOWN_MS || 300000),
    notifyStartup: parseBoolean(process.env.FEISHU_NOTIFY_STARTUP, true),
    notifyTradeSuccess: parseBoolean(process.env.FEISHU_NOTIFY_TRADE_SUCCESS, true),
    notifyTradeFailure: parseBoolean(process.env.FEISHU_NOTIFY_TRADE_FAILURE, true),
    notifyRuntimeIssues: parseBoolean(process.env.FEISHU_NOTIFY_RUNTIME_ISSUES, true),
    notifyGuardEvents: parseBoolean(process.env.FEISHU_NOTIFY_GUARD_EVENTS, true),
    notifyDryRun: parseBoolean(process.env.FEISHU_NOTIFY_DRY_RUN, false),
    notifyWeeklySummary: parseBoolean(process.env.FEISHU_NOTIFY_WEEKLY_SUMMARY, true),
    notifyDailyDcaSuccess: parseBoolean(process.env.FEISHU_NOTIFY_DAILY_DCA_SUCCESS, false),
    notifyDeepBuySuccess: parseBoolean(process.env.FEISHU_NOTIFY_DEEP_BUY_SUCCESS, true),
    notifyDeepBuyCooldownSkip: parseBoolean(
      process.env.FEISHU_NOTIFY_DEEP_BUY_COOLDOWN_SKIP,
      false,
    ),
  },
  logger,
);

const provider = new ethers.JsonRpcProvider(CONFIG.baseRpcUrl, Number(BASE_CHAIN_INDEX));
const baseWallet = CONFIG.basePrivateKey
  ? new ethers.Wallet(CONFIG.basePrivateKey, provider)
  : null;
const signer = baseWallet ? new ethers.NonceManager(baseWallet) : null;
const walletAddress = resolveWalletAddress();
const erc20Interface = new ethers.Interface(ERC20_ABI);
const strategyMap = buildStrategyMap();
const strategyPriority = ["deep_discount_buy", "daily_dca"];
const maxStrategyAmountBaseUnits = strategyPriority.reduce((maxAmount, strategyId) => {
  const strategy = strategyMap[strategyId];
  return strategy && strategy.amountBaseUnits > maxAmount ? strategy.amountBaseUnits : maxAmount;
}, 0n);
const approveAmountBaseUnits = CONFIG.approveAmountUsdc
  ? ethers.parseUnits(CONFIG.approveAmountUsdc, 6)
  : maxStrategyAmountBaseUnits;
const dailyBuyBudgetBaseUnits = ethers.parseUnits(CONFIG.dailyBuyBudgetUsdc, 6);
const minBaseEthBalanceWei = ethers.parseEther(CONFIG.minBaseEthBalance);
const maxAidogBalanceBaseUnits = CONFIG.maxAidogBalance
  ? ethers.parseUnits(CONFIG.maxAidogBalance, 18)
  : null;

let state = loadState();
let stopped = false;
let samplesCollected = 0;
let previousPrice = typeof state.runtime.lastObservedPrice === "number"
  ? state.runtime.lastObservedPrice
  : null;
let activeSkipSignatures = new Set();
let lockHeld = false;

process.on("SIGINT", handleStop);
process.on("SIGTERM", handleStop);

main()
  .catch(async (error) => {
    logger.error("Bot crashed", serializeError(error));
    incrementWeeklyCounter("runtimeIssueCount");
    await notifier.notifyRuntimeIssue(
      "机器人异常退出",
      [
        `钱包：${shortAddress(walletAddress)}`,
        `错误信息：${error instanceof Error ? error.message : String(error)}`,
      ],
      {
        throttleKey: "bot-crashed",
        throttleMs: 0,
      },
    );
    process.exitCode = 1;
  })
  .finally(() => {
    releaseProcessLock();
  });

async function main() {
  acquireProcessLock();
  validateConfig();
  rollDailyState(getTradingTimeParts());
  rollWeeklyState(getTradingWeekInfo());

  if (usingSharedOkxCredentials()) {
    logger.warn(
      "Using OKX shared test credentials. Set OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE in .env for stable usage.",
    );
  }

  logger.info("Bot started", {
    wallet: shortAddress(walletAddress),
    tradingTimezone: CONFIG.tradingTimeZone,
    dailyDcaThresholdUsd: CONFIG.dailyDca.thresholdUsd,
    dailyDcaAmountUsdc: CONFIG.dailyDca.amountUsdc,
    dailyDcaTimeLocal: `${pad2(CONFIG.dailyDca.displayHour)}:${pad2(CONFIG.dailyDca.minute)}`,
    deepBuyThresholdUsd: CONFIG.deepBuy.thresholdUsd,
    deepBuyAmountUsdc: CONFIG.deepBuy.amountUsdc,
    deepBuyCooldownDays: CONFIG.deepBuy.cooldownDays,
    dryRun: CONFIG.dryRun,
  });
  await notifier.notifyLifecycle("机器人已启动", [
    `钱包：${shortAddress(walletAddress)}`,
    `时区：${CONFIG.tradingTimeZone}`,
    `每日定投：低于等于 ${CONFIG.dailyDca.thresholdUsd} USD，买入 ${CONFIG.dailyDca.amountUsdc} USDC，时间 ${pad2(CONFIG.dailyDca.displayHour)}:${pad2(CONFIG.dailyDca.minute)}`,
    `深跌加仓：低于等于 ${CONFIG.deepBuy.thresholdUsd} USD，买入 ${CONFIG.deepBuy.amountUsdc} USDC，冷却 ${CONFIG.deepBuy.cooldownDays} 天`,
    `模拟模式：${CONFIG.dryRun ? "开启" : "关闭"}`,
  ], {
    actions: [
      {
        text: "查看钱包",
        url: `https://basescan.org/address/${walletAddress}`,
        type: "default",
      },
    ],
  });

  while (!stopped) {
    const tradingTime = getTradingTimeParts();
    const tradingWeek = getTradingWeekInfo();
    rollDailyState(tradingTime);
    rollWeeklyState(tradingWeek);

    const pendingResult = await reconcilePendingTransaction(tradingTime);
    if (pendingResult === "waiting") {
      await sleep(CONFIG.pollIntervalMs);
      continue;
    }
    if (pendingResult === "stop") {
      return;
    }

    await maybeSendWeeklySummary(tradingTime, tradingWeek);

    let sample;
    try {
      sample = await fetchMarketPrice();
    } catch (error) {
      logger.error("Price request failed", serializeError(error));
      incrementWeeklyCounter("runtimeIssueCount");
      await notifier.notifyRuntimeIssue(
        "价格查询失败",
        [
          `钱包：${shortAddress(walletAddress)}`,
          `错误信息：${error instanceof Error ? error.message : String(error)}`,
        ],
        {
          throttleKey: "price-request-failed",
        },
      );
      await sleep(CONFIG.pollIntervalMs);
      continue;
    }

    samplesCollected += 1;
    recordObservedPrice(sample);

    const evaluation = evaluateStrategies(sample.price, tradingTime);
    await processSkipEvents(evaluation.skips);

    for (const signal of evaluation.signals) {
      const result = await executeSignal(signal, sample.price, tradingTime);
      if (result === "stop") {
        return;
      }
    }

    if (CONFIG.maxSamples > 0 && samplesCollected >= CONFIG.maxSamples) {
      logger.info("Max samples reached, exiting", { maxSamples: CONFIG.maxSamples });
      return;
    }

    await sleep(CONFIG.pollIntervalMs);
  }

  logger.info("Bot stopped");
}

async function executeSignal(strategy, triggerPrice, tradingTime) {
  state.runtime.lastAttemptAtMs = Date.now();
  saveState();

  for (let attempt = 1; attempt <= CONFIG.maxTradeAttempts; attempt += 1) {
    try {
      const trade = await attemptBuy(strategy, triggerPrice, attempt, tradingTime);

      if (trade.status === "dry-run") {
        clearFailureState();
        saveState();
        return CONFIG.buyOnce ? "stop" : "continue";
      }

      await recordSuccessfulTrade(strategy, trade, triggerPrice, tradingTime);

      if (CONFIG.buyOnce) {
        logger.info("BUY_ONCE enabled, exiting after successful trade");
        return "stop";
      }

      return "continue";
    } catch (error) {
      const details = serializeError(error);
      const retryable = isRetryableTradeError(error);

      logger.error("Trade attempt failed", {
        strategy: strategy.id,
        attempt,
        maxAttempts: CONFIG.maxTradeAttempts,
        retryable,
        ...details,
      });

      if (shouldResetSignerNonce(error)) {
        resetSignerNonce();
      }

      if (!retryable || attempt >= CONFIG.maxTradeAttempts) {
        state.runtime.lastFailureAtMs = Date.now();
        state.runtime.lastFailureReason = `${strategy.id}: ${details.message || "trade failed"}`;
        if (strategy.id === "daily_dca" && shouldPersistDailyDcaGuardFailure(details.code)) {
          state.strategies.daily_dca = rememberDailyDcaGuardFailure(
            state.strategies.daily_dca,
            tradingTime.dayKey,
            details.code,
          );
        }
        saveState();
        await notifyTradeFailure(strategy, error, triggerPrice, attempt);
        return "continue";
      }

      await sleep(CONFIG.tradeRetryBaseMs * attempt);
    }
  }

  return "continue";
}

async function attemptBuy(strategy, triggerPrice, attemptNumber, tradingTime) {
  const walletSnapshot = await getWalletSnapshot();
  enforceWalletGuards(strategy, walletSnapshot);

  const quote = await fetchSwapQuote({
    amount: strategy.amountBaseUnits.toString(),
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

  logger.info("Trade trigger hit", {
    strategy: strategy.id,
    attempt: attemptNumber,
    triggerPriceUsd: triggerPrice,
    buyAmountUsdc: strategy.amountUsdc,
    expectedAidog,
    route: route || "n/a",
    priceImpact: quote.priceImpactPercent,
    taxRate: quote.toToken.taxRate,
  });

  const approveInfo = await fetchApproveTransaction({
    approveAmount: approveAmountBaseUnits.toString(),
    tokenContractAddress: BASE_USDC_TOKEN_ADDRESS,
  });

  const allowance = await readErc20Uint256(BASE_USDC_TOKEN_ADDRESS, "allowance", [
    walletAddress,
    approveInfo.dexContractAddress,
  ]);

  if (CONFIG.dryRun) {
    logger.info("Dry run complete", {
      strategy: strategy.id,
      needsApproval: allowance < strategy.amountBaseUnits,
      currentUsdcBalance: ethers.formatUnits(walletSnapshot.usdcBalance, 6),
      currentAidogBalance: ethers.formatUnits(walletSnapshot.aidogBalance, 18),
    });
    await notifier.notifyDryRun({
      wallet: shortAddress(walletAddress),
      strategy: strategy.label,
      triggerPriceUsd: Number(triggerPrice.toFixed(8)),
      buyAmountUsdc: strategy.amountUsdc,
      expectedAidog,
      route: route || "n/a",
      needsApproval: allowance < strategy.amountBaseUnits,
      walletUsdc: ethers.formatUnits(walletSnapshot.usdcBalance, 6),
      walletAidog: ethers.formatUnits(walletSnapshot.aidogBalance, 18),
      walletExplorerUrl: `https://basescan.org/address/${walletAddress}`,
    });

    return {
      status: "dry-run",
    };
  }

  if (!signer) {
    throw createBotError("MISSING_PRIVATE_KEY", "BASE_PRIVATE_KEY is required when DRY_RUN=false.");
  }

  if (allowance < strategy.amountBaseUnits) {
    const approvalTx = await sendTransactionWithSyncedNonce({
      to: BASE_USDC_TOKEN_ADDRESS,
      data: approveInfo.data,
      gasLimit: padGasLimit(approveInfo.gasLimit),
    });

    setPendingTransaction({
      stage: "approve",
      strategyId: strategy.id,
      txHash: approvalTx.hash,
      triggerPriceUsd: triggerPrice,
      tradingDayKey: null,
      route: "",
      sentAtMs: Date.now(),
      walletSnapshotBefore: null,
    });

    logger.info("Approval transaction sent", {
      strategy: strategy.id,
      hash: approvalTx.hash,
      approveAmountUsdc: ethers.formatUnits(approveAmountBaseUnits, 6),
    });

    const approvalReceipt = await approvalTx.wait(CONFIG.confirmationsRequired);
    clearPendingTransaction();
    logger.info("Approval transaction confirmed", {
      strategy: strategy.id,
      hash: approvalReceipt.hash,
      blockNumber: approvalReceipt.blockNumber,
      gasUsed: approvalReceipt.gasUsed.toString(),
    });
  }

  const swapResult = await fetchSwapTransaction({
    amount: strategy.amountBaseUnits.toString(),
    fromTokenAddress: BASE_USDC_TOKEN_ADDRESS,
    toTokenAddress: AIDOG_TOKEN_ADDRESS,
    slippagePercent: CONFIG.slippagePercent,
    userWalletAddress: walletAddress,
  });

  await provider.call({
    from: walletAddress,
    to: swapResult.tx.to,
    data: swapResult.tx.data,
    value: swapResult.tx.value,
  });

  const swapTx = await sendTransactionWithSyncedNonce({
    to: swapResult.tx.to,
    data: swapResult.tx.data,
    value: swapResult.tx.value,
    gasLimit: padGasLimit(swapResult.tx.gas),
  });

  setPendingTransaction({
    stage: "swap",
    strategyId: strategy.id,
    txHash: swapTx.hash,
    triggerPriceUsd: triggerPrice,
    tradingDayKey: tradingTime.dayKey,
    route: route || "n/a",
    sentAtMs: Date.now(),
    amountBaseUnits: strategy.amountBaseUnits.toString(),
    quotedAidogBaseUnits: quote.toTokenAmount.toString(),
    walletSnapshotBefore: serializeWalletSnapshot(walletSnapshot),
  });

  logger.info("Swap transaction sent", {
    strategy: strategy.id,
    hash: swapTx.hash,
    quotedAidog: expectedAidog,
    minReceiveAmount: ethers.formatUnits(swapResult.tx.minReceiveAmount, 18),
  });

  const receipt = await swapTx.wait(CONFIG.confirmationsRequired);
  const postTradeSnapshot = await getWalletSnapshot();
  const recoveredAmounts = recoverTradeAmounts({
    receipt,
    walletAddress,
    spentTokenAddress: BASE_USDC_TOKEN_ADDRESS,
    receivedTokenAddress: AIDOG_TOKEN_ADDRESS,
    fallbackSpentBaseUnits: strategy.amountBaseUnits.toString(),
    fallbackReceivedBaseUnits: quote.toTokenAmount.toString(),
    walletSnapshotBefore: walletSnapshot,
    walletSnapshotAfter: postTradeSnapshot,
  });
  const normalizedPostTradeSnapshot = mergeTradeSnapshotWithRecoveredAmounts({
    walletSnapshotBefore: walletSnapshot,
    walletSnapshotAfter: postTradeSnapshot,
    spentBaseUnits: recoveredAmounts.spentBaseUnits,
    receivedBaseUnits: recoveredAmounts.receivedBaseUnits,
  });

  return {
    status: "executed",
    route,
    receipt,
    swapHash: swapTx.hash,
    usdcDelta: recoveredAmounts.spentBaseUnits,
    aidogDelta: recoveredAmounts.receivedBaseUnits,
    amountSource: {
      spent: recoveredAmounts.spentSource,
      received: recoveredAmounts.receivedSource,
    },
    postTradeSnapshot: normalizedPostTradeSnapshot,
  };
}

function buildConfig() {
  const tradingTimeZone = process.env.TRADING_TIMEZONE || "Asia/Shanghai";
  const dailyDcaHourInput = Number(process.env.DAILY_DCA_HOUR || 24);

  return {
    baseRpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
    basePrivateKey: process.env.BASE_PRIVATE_KEY || "",
    configuredWalletAddress: process.env.BASE_WALLET_ADDRESS || "",
    tradingTimeZone,
    dryRun: parseBoolean(process.env.DRY_RUN, true),
    buyOnce: parseBoolean(process.env.BUY_ONCE, false),
    maxSamples: Number(process.env.MAX_SAMPLES || 0),
    slippagePercent: process.env.SLIPPAGE_PERCENT || "1",
    maxPriceImpactPercent: Number(process.env.MAX_PRICE_IMPACT_PERCENT || 5),
    maxTaxRate: Number(process.env.MAX_TAX_RATE || 0.05),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 5000),
    maxTradeAttempts: Number(process.env.MAX_TRADE_ATTEMPTS || 2),
    tradeRetryBaseMs: Number(process.env.TRADE_RETRY_BASE_MS || 1500),
    confirmationsRequired: Number(process.env.CONFIRMATIONS_REQUIRED || 1),
    gasLimitMultiplier: Number(process.env.GAS_LIMIT_MULTIPLIER || 1.2),
    approveAmountUsdc: process.env.APPROVE_AMOUNT_USDC || "",
    maxBuysPerDay: Number(process.env.MAX_BUYS_PER_DAY || 2),
    dailyBuyBudgetUsdc: process.env.DAILY_BUY_BUDGET_USDC || "12",
    minBaseEthBalance: process.env.MIN_BASE_ETH_BALANCE || "0.0001",
    maxAidogBalance: process.env.MAX_AIDOG_BALANCE || "",
    dailyDca: {
      enabled: parseBoolean(process.env.DAILY_DCA_ENABLED, true),
      thresholdUsd: Number(process.env.DAILY_DCA_THRESHOLD_USD || 0.005),
      amountUsdc: process.env.DAILY_DCA_AMOUNT_USDC || "2",
      displayHour: dailyDcaHourInput,
      hour: dailyDcaHourInput === 24 ? 0 : dailyDcaHourInput,
      minute: Number(process.env.DAILY_DCA_MINUTE || 0),
      windowMinutes: Number(process.env.DAILY_DCA_WINDOW_MINUTES || 30),
    },
    deepBuy: {
      enabled: parseBoolean(process.env.DEEP_BUY_ENABLED, true),
      thresholdUsd: Number(process.env.DEEP_BUY_THRESHOLD_USD || 0.004),
      amountUsdc: process.env.DEEP_BUY_AMOUNT_USDC || "10",
      cooldownDays: Number(process.env.DEEP_BUY_COOLDOWN_DAYS || 5),
    },
    weeklySummary: {
      enabled: parseBoolean(process.env.WEEKLY_SUMMARY_ENABLED, true),
      weekday: Number(process.env.WEEKLY_SUMMARY_WEEKDAY || 1),
      hour: Number(process.env.WEEKLY_SUMMARY_HOUR || 0),
      minute: Number(process.env.WEEKLY_SUMMARY_MINUTE || 10),
    },
  };
}

function buildStrategyMap() {
  return {
    daily_dca: {
      id: "daily_dca",
      label: "每日定投",
      enabled: CONFIG.dailyDca.enabled,
      thresholdUsd: CONFIG.dailyDca.thresholdUsd,
      amountUsdc: CONFIG.dailyDca.amountUsdc,
      amountBaseUnits: ethers.parseUnits(CONFIG.dailyDca.amountUsdc, 6),
    },
    deep_discount_buy: {
      id: "deep_discount_buy",
      label: "深跌加仓",
      enabled: CONFIG.deepBuy.enabled,
      thresholdUsd: CONFIG.deepBuy.thresholdUsd,
      amountUsdc: CONFIG.deepBuy.amountUsdc,
      amountBaseUnits: ethers.parseUnits(CONFIG.deepBuy.amountUsdc, 6),
    },
  };
}

function validateConfig() {
  if (!Number.isFinite(CONFIG.pollIntervalMs) || CONFIG.pollIntervalMs < 1000) {
    throw createBotError("BAD_CONFIG", "POLL_INTERVAL_MS must be at least 1000.");
  }

  if (
    !Number.isInteger(CONFIG.dailyDca.displayHour) ||
    CONFIG.dailyDca.displayHour < 0 ||
    CONFIG.dailyDca.displayHour > 24
  ) {
    throw createBotError("BAD_CONFIG", "DAILY_DCA_HOUR must be an integer from 0 to 24.");
  }

  if (
    !Number.isInteger(CONFIG.dailyDca.minute) ||
    CONFIG.dailyDca.minute < 0 ||
    CONFIG.dailyDca.minute > 59
  ) {
    throw createBotError("BAD_CONFIG", "DAILY_DCA_MINUTE must be an integer from 0 to 59.");
  }

  if (CONFIG.dailyDca.displayHour === 24 && CONFIG.dailyDca.minute !== 0) {
    throw createBotError("BAD_CONFIG", "24:00 only supports DAILY_DCA_MINUTE=0.");
  }

  if (
    !Number.isInteger(CONFIG.dailyDca.windowMinutes) ||
    CONFIG.dailyDca.windowMinutes <= 0
  ) {
    throw createBotError("BAD_CONFIG", "DAILY_DCA_WINDOW_MINUTES must be a positive integer.");
  }

  if (
    !Number.isInteger(CONFIG.weeklySummary.weekday) ||
    CONFIG.weeklySummary.weekday < 1 ||
    CONFIG.weeklySummary.weekday > 7
  ) {
    throw createBotError("BAD_CONFIG", "WEEKLY_SUMMARY_WEEKDAY must be an integer from 1 to 7.");
  }

  if (
    !Number.isInteger(CONFIG.weeklySummary.hour) ||
    CONFIG.weeklySummary.hour < 0 ||
    CONFIG.weeklySummary.hour > 23
  ) {
    throw createBotError("BAD_CONFIG", "WEEKLY_SUMMARY_HOUR must be an integer from 0 to 23.");
  }

  if (
    !Number.isInteger(CONFIG.weeklySummary.minute) ||
    CONFIG.weeklySummary.minute < 0 ||
    CONFIG.weeklySummary.minute > 59
  ) {
    throw createBotError("BAD_CONFIG", "WEEKLY_SUMMARY_MINUTE must be an integer from 0 to 59.");
  }

  if (!Number.isFinite(CONFIG.dailyDca.thresholdUsd) || CONFIG.dailyDca.thresholdUsd <= 0) {
    throw createBotError("BAD_CONFIG", "DAILY_DCA_THRESHOLD_USD must be a positive number.");
  }

  if (!Number.isFinite(CONFIG.deepBuy.thresholdUsd) || CONFIG.deepBuy.thresholdUsd <= 0) {
    throw createBotError("BAD_CONFIG", "DEEP_BUY_THRESHOLD_USD must be a positive number.");
  }

  if (
    CONFIG.dailyDca.enabled &&
    CONFIG.deepBuy.enabled &&
    CONFIG.deepBuy.thresholdUsd > CONFIG.dailyDca.thresholdUsd
  ) {
    throw createBotError(
      "BAD_CONFIG",
      "DEEP_BUY_THRESHOLD_USD should be less than or equal to DAILY_DCA_THRESHOLD_USD.",
    );
  }

  if (!Number.isFinite(CONFIG.deepBuy.cooldownDays) || CONFIG.deepBuy.cooldownDays < 1) {
    throw createBotError("BAD_CONFIG", "DEEP_BUY_COOLDOWN_DAYS must be at least 1.");
  }

  if (approveAmountBaseUnits < maxStrategyAmountBaseUnits) {
    throw createBotError(
      "BAD_CONFIG",
      "APPROVE_AMOUNT_USDC must be greater than or equal to the largest strategy amount.",
    );
  }
}

function loadState() {
  return normalizeState(
    loadJsonFile(STATE_FILE, {
      version: 2,
      runtime: {
        lastObservedPrice: null,
        lastObservedAtMs: 0,
        lastAttemptAtMs: 0,
        lastFailureAtMs: 0,
        lastFailureReason: "",
      },
      daily: {
        date: getTradingTimeParts().dayKey,
        buyCount: 0,
        spentUsdcBaseUnits: "0",
        receivedAidogBaseUnits: "0",
      },
      strategies: {
        daily_dca: {
          lastExecutedDayKey: "",
          lastSuccessAtMs: 0,
          lastSuccessTxHash: "",
          lastSkippedDayKey: "",
          lastSkipCode: "",
        },
        deep_discount_buy: {
          lastExecutedAtMs: 0,
          lastSuccessTxHash: "",
        },
      },
      weekly: createBlankWeeklyState(getTradingWeekInfo()),
      previousWeekly: null,
      notifications: {
        lastWeeklySummaryPeriodKey: "",
      },
      pendingTx: null,
      lastTrade: null,
    }),
  );
}

function normalizeState(rawState) {
  return {
    version: 2,
    runtime: {
      lastObservedPrice:
        typeof rawState?.runtime?.lastObservedPrice === "number"
          ? rawState.runtime.lastObservedPrice
          : typeof rawState?.cycle?.lastObservedPrice === "number"
            ? rawState.cycle.lastObservedPrice
            : null,
      lastObservedAtMs: Number(rawState?.runtime?.lastObservedAtMs || rawState?.cycle?.lastObservedAtMs || 0),
      lastAttemptAtMs: Number(rawState?.runtime?.lastAttemptAtMs || rawState?.cycle?.lastAttemptAtMs || 0),
      lastFailureAtMs: Number(rawState?.runtime?.lastFailureAtMs || rawState?.cycle?.lastFailureAtMs || 0),
      lastFailureReason: String(rawState?.runtime?.lastFailureReason || rawState?.cycle?.lastFailureReason || ""),
    },
    daily: {
      date: String(rawState?.daily?.date || getTradingTimeParts().dayKey),
      buyCount: Number(rawState?.daily?.buyCount || 0),
      spentUsdcBaseUnits: String(rawState?.daily?.spentUsdcBaseUnits || "0"),
      receivedAidogBaseUnits: String(rawState?.daily?.receivedAidogBaseUnits || "0"),
    },
    strategies: {
      daily_dca: normalizeDailyDcaState(rawState?.strategies?.daily_dca),
      deep_discount_buy: {
        lastExecutedAtMs: Number(rawState?.strategies?.deep_discount_buy?.lastExecutedAtMs || 0),
        lastSuccessTxHash: String(rawState?.strategies?.deep_discount_buy?.lastSuccessTxHash || ""),
      },
    },
    weekly: normalizeWeeklyState(rawState?.weekly, getTradingWeekInfo()),
    previousWeekly: normalizeWeeklyState(rawState?.previousWeekly, getTradingWeekInfo()),
    notifications: {
      lastWeeklySummaryPeriodKey: String(rawState?.notifications?.lastWeeklySummaryPeriodKey || ""),
    },
    pendingTx: normalizePendingTx(rawState?.pendingTx),
    lastTrade: rawState?.lastTrade || null,
  };
}

function normalizePendingTx(rawPendingTx) {
  if (!rawPendingTx?.txHash || !rawPendingTx?.strategyId || !rawPendingTx?.stage) {
    return null;
  }

  return {
    stage: String(rawPendingTx.stage),
    strategyId: String(rawPendingTx.strategyId),
    txHash: String(rawPendingTx.txHash),
    triggerPriceUsd: Number(rawPendingTx.triggerPriceUsd || 0),
    tradingDayKey: rawPendingTx.tradingDayKey ? String(rawPendingTx.tradingDayKey) : null,
    route: String(rawPendingTx.route || ""),
    sentAtMs: Number(rawPendingTx.sentAtMs || 0),
    amountBaseUnits: rawPendingTx.amountBaseUnits
      ? String(rawPendingTx.amountBaseUnits)
      : null,
    quotedAidogBaseUnits: rawPendingTx.quotedAidogBaseUnits
      ? String(rawPendingTx.quotedAidogBaseUnits)
      : null,
    walletSnapshotBefore: rawPendingTx.walletSnapshotBefore
      ? {
          baseEthBalance: String(rawPendingTx.walletSnapshotBefore.baseEthBalance || "0"),
          usdcBalance: String(rawPendingTx.walletSnapshotBefore.usdcBalance || "0"),
          aidogBalance: String(rawPendingTx.walletSnapshotBefore.aidogBalance || "0"),
        }
      : null,
  };
}

function createBlankWeeklyState(weekInfo) {
  return {
    periodKey: weekInfo.weekKey,
    weekStartDayKey: weekInfo.weekStartDayKey,
    weekEndDayKey: weekInfo.weekEndDayKey,
    buyCount: 0,
    spentUsdcBaseUnits: "0",
    receivedAidogBaseUnits: "0",
    failureCount: 0,
    guardCount: 0,
    runtimeIssueCount: 0,
    strategies: {
      daily_dca: {
        buyCount: 0,
        spentUsdcBaseUnits: "0",
        receivedAidogBaseUnits: "0",
      },
      deep_discount_buy: {
        buyCount: 0,
        spentUsdcBaseUnits: "0",
        receivedAidogBaseUnits: "0",
      },
    },
    lastTrade: null,
  };
}

function normalizeWeeklyState(rawWeeklyState, fallbackWeekInfo) {
  if (!rawWeeklyState?.periodKey) {
    return rawWeeklyState == null ? null : createBlankWeeklyState(fallbackWeekInfo);
  }

  return {
    periodKey: String(rawWeeklyState.periodKey),
    weekStartDayKey: String(rawWeeklyState.weekStartDayKey || rawWeeklyState.periodKey),
    weekEndDayKey: String(rawWeeklyState.weekEndDayKey || rawWeeklyState.periodKey),
    buyCount: Number(rawWeeklyState.buyCount || 0),
    spentUsdcBaseUnits: String(rawWeeklyState.spentUsdcBaseUnits || "0"),
    receivedAidogBaseUnits: String(rawWeeklyState.receivedAidogBaseUnits || "0"),
    failureCount: Number(rawWeeklyState.failureCount || 0),
    guardCount: Number(rawWeeklyState.guardCount || 0),
    runtimeIssueCount: Number(rawWeeklyState.runtimeIssueCount || 0),
    strategies: {
      daily_dca: {
        buyCount: Number(rawWeeklyState?.strategies?.daily_dca?.buyCount || 0),
        spentUsdcBaseUnits: String(rawWeeklyState?.strategies?.daily_dca?.spentUsdcBaseUnits || "0"),
        receivedAidogBaseUnits: String(rawWeeklyState?.strategies?.daily_dca?.receivedAidogBaseUnits || "0"),
      },
      deep_discount_buy: {
        buyCount: Number(rawWeeklyState?.strategies?.deep_discount_buy?.buyCount || 0),
        spentUsdcBaseUnits: String(rawWeeklyState?.strategies?.deep_discount_buy?.spentUsdcBaseUnits || "0"),
        receivedAidogBaseUnits: String(rawWeeklyState?.strategies?.deep_discount_buy?.receivedAidogBaseUnits || "0"),
      },
    },
    lastTrade: rawWeeklyState.lastTrade || null,
  };
}

function setPendingTransaction(pendingTx) {
  state.pendingTx = pendingTx;
  saveState();
}

function clearPendingTransaction() {
  if (!state.pendingTx) {
    return;
  }

  state.pendingTx = null;
  saveState();
}

function serializeWalletSnapshot(walletSnapshot) {
  return {
    baseEthBalance: walletSnapshot.baseEthBalance.toString(),
    usdcBalance: walletSnapshot.usdcBalance.toString(),
    aidogBalance: walletSnapshot.aidogBalance.toString(),
  };
}

function deserializeWalletSnapshot(snapshot) {
  return {
    baseEthBalance: BigInt(snapshot.baseEthBalance),
    usdcBalance: BigInt(snapshot.usdcBalance),
    aidogBalance: BigInt(snapshot.aidogBalance),
  };
}

function getWeeklyTradeBucket(summaryWeek) {
  if (!state.weekly) {
    state.weekly = createBlankWeeklyState(getTradingWeekInfo());
  }

  if (!summaryWeek?.weekKey || state.weekly.periodKey === summaryWeek.weekKey) {
    return {
      bucketName: "weekly",
      bucket: state.weekly,
    };
  }

  if (state.previousWeekly?.periodKey === summaryWeek.weekKey) {
    return {
      bucketName: "previousWeekly",
      bucket: state.previousWeekly,
    };
  }

  logger.warn("Recovered trade week did not match current summary buckets", {
    summaryWeek: summaryWeek?.weekKey || "n/a",
    currentWeek: state.weekly.periodKey,
    previousWeek: state.previousWeekly?.periodKey || "n/a",
  });

  return {
    bucketName: "weekly",
    bucket: state.weekly,
  };
}

function shouldReplaceLastTrade(existingTrade, executedAtMs) {
  if (!existingTrade?.executedAtMs) {
    return true;
  }

  return Number(existingTrade.executedAtMs) <= Number(executedAtMs);
}

async function resolveReceiptExecutedAtMs(receipt, fallbackMs) {
  if (!receipt?.blockNumber) {
    return fallbackMs;
  }

  try {
    const block = await provider.getBlock(receipt.blockNumber);
    if (block?.timestamp) {
      return Number(block.timestamp) * 1000;
    }
  } catch (error) {
    logger.warn("Receipt block lookup failed", {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      ...serializeError(error),
    });
  }

  return fallbackMs;
}

function acquireProcessLock() {
  ensureDirectory(path.dirname(LOCK_FILE));
  const lockPayload = JSON.stringify(
    {
      pid: process.pid,
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  );

  try {
    fs.writeFileSync(LOCK_FILE, `${lockPayload}\n`, { encoding: "utf8", flag: "wx" });
    lockHeld = true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }

    const existingLock = readLockFile();
    if (existingLock?.pid && !isProcessRunning(existingLock.pid)) {
      fs.rmSync(LOCK_FILE, { force: true });
      fs.writeFileSync(LOCK_FILE, `${lockPayload}\n`, { encoding: "utf8", flag: "wx" });
      lockHeld = true;
      logger.warn("Recovered stale lock file", {
        lockFile: LOCK_FILE,
        stalePid: existingLock.pid,
      });
      return;
    }

    throw createBotError(
      "LOCKED",
      `Another bot instance appears to be running. Lock file: ${LOCK_FILE}`,
    );
  }
}

function releaseProcessLock() {
  if (!lockHeld) {
    return;
  }

  const existingLock = readLockFile();
  if (existingLock?.pid && existingLock.pid !== process.pid) {
    return;
  }

  fs.rmSync(LOCK_FILE, { force: true });
  lockHeld = false;
}

function readLockFile() {
  try {
    if (!fs.existsSync(LOCK_FILE)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function saveState() {
  saveJsonFile(STATE_FILE, state);
}

function getTradingTimeParts(date = new Date()) {
  return getTimeZoneParts(CONFIG.tradingTimeZone, date);
}

function getTradingWeekInfo(date = new Date()) {
  return getWeekTimeZoneInfo(CONFIG.tradingTimeZone, date);
}

function rollDailyState(tradingTime) {
  if (state.daily.date === tradingTime.dayKey) {
    return;
  }

  logger.info("Rolling daily counters", {
    previousDate: state.daily.date,
    nextDate: tradingTime.dayKey,
    timezone: CONFIG.tradingTimeZone,
  });

  state.daily = {
    date: tradingTime.dayKey,
    buyCount: 0,
    spentUsdcBaseUnits: "0",
    receivedAidogBaseUnits: "0",
  };
  saveState();
}

function rollWeeklyState(tradingWeek) {
  if (state.weekly?.periodKey === tradingWeek.weekKey) {
    return;
  }

  logger.info("Rolling weekly counters", {
    previousPeriod: state.weekly?.periodKey || "n/a",
    nextPeriod: tradingWeek.weekKey,
    timezone: CONFIG.tradingTimeZone,
  });

  if (state.weekly?.periodKey) {
    state.previousWeekly = state.weekly;
  }

  state.weekly = createBlankWeeklyState(tradingWeek);
  saveState();
}

function recordObservedPrice(sample) {
  const delta =
    previousPrice == null ? null : ((sample.price - previousPrice) / previousPrice) * 100;

  logger.info("Price sample", {
    priceUsd: Number(sample.price.toFixed(8)),
    changeVsLastSample: delta == null ? "n/a" : formatPercent(delta),
    dailyDcaThresholdUsd: CONFIG.dailyDca.thresholdUsd,
    deepBuyThresholdUsd: CONFIG.deepBuy.thresholdUsd,
  });

  previousPrice = sample.price;
  state.runtime.lastObservedPrice = sample.price;
  state.runtime.lastObservedAtMs = sample.time;
  saveState();
}

async function maybeSendWeeklySummary(tradingTime, tradingWeek) {
  if (!CONFIG.weeklySummary.enabled || !notifier.enabled || !state.previousWeekly?.periodKey) {
    return;
  }

  if (state.notifications.lastWeeklySummaryPeriodKey === state.previousWeekly.periodKey) {
    return;
  }

  if (!isWeeklySummaryDue(tradingTime, tradingWeek)) {
    return;
  }

  let walletSnapshot = null;
  let currentPrice = state.runtime.lastObservedPrice;

  try {
    walletSnapshot = await getWalletSnapshot();
  } catch (error) {
    logger.warn("Weekly summary wallet snapshot failed", serializeError(error));
  }

  if (currentPrice == null) {
    try {
      const priceSample = await fetchMarketPrice();
      currentPrice = priceSample.price;
    } catch (error) {
      logger.warn("Weekly summary price snapshot failed", serializeError(error));
    }
  }

  const sent = await notifier.notifyWeeklySummary({
    wallet: shortAddress(walletAddress),
    weekTitle: formatWeekTitle(state.previousWeekly.weekStartDayKey),
    periodLabel: `${state.previousWeekly.weekStartDayKey} ~ ${state.previousWeekly.weekEndDayKey}`,
    totalBuyCount: state.previousWeekly.buyCount,
    totalSpentUsdc: ethers.formatUnits(state.previousWeekly.spentUsdcBaseUnits, 6),
    totalReceivedAidog: ethers.formatUnits(state.previousWeekly.receivedAidogBaseUnits, 18),
    dailyDcaBuyCount: state.previousWeekly.strategies.daily_dca.buyCount,
    dailyDcaSpentUsdc: ethers.formatUnits(state.previousWeekly.strategies.daily_dca.spentUsdcBaseUnits, 6),
    dailyDcaReceivedAidog: ethers.formatUnits(state.previousWeekly.strategies.daily_dca.receivedAidogBaseUnits, 18),
    deepBuyCount: state.previousWeekly.strategies.deep_discount_buy.buyCount,
    deepBuySpentUsdc: ethers.formatUnits(state.previousWeekly.strategies.deep_discount_buy.spentUsdcBaseUnits, 6),
    deepBuyReceivedAidog: ethers.formatUnits(state.previousWeekly.strategies.deep_discount_buy.receivedAidogBaseUnits, 18),
    failureCount: state.previousWeekly.failureCount,
    guardCount: state.previousWeekly.guardCount,
    runtimeIssueCount: state.previousWeekly.runtimeIssueCount,
    currentEth: walletSnapshot ? ethers.formatEther(walletSnapshot.baseEthBalance) : "n/a",
    currentUsdc: walletSnapshot ? ethers.formatUnits(walletSnapshot.usdcBalance, 6) : "n/a",
    currentAidog: walletSnapshot ? ethers.formatUnits(walletSnapshot.aidogBalance, 18) : "n/a",
    currentPriceUsd: currentPrice == null ? "n/a" : Number(currentPrice.toFixed(8)),
    lastTrade: state.previousWeekly.lastTrade,
    walletExplorerUrl: `https://basescan.org/address/${walletAddress}`,
  });

  if (sent) {
    state.notifications.lastWeeklySummaryPeriodKey = state.previousWeekly.periodKey;
    saveState();
    logger.info("Weekly summary sent", {
      periodKey: state.previousWeekly.periodKey,
    });
  }
}

function isWeeklySummaryDue(tradingTime, tradingWeek) {
  const scheduledMinutes =
    CONFIG.weeklySummary.hour * 60 + CONFIG.weeklySummary.minute;
  const currentMinutes = tradingTime.hour * 60 + tradingTime.minute;

  return (
    tradingWeek.isoWeekday > CONFIG.weeklySummary.weekday ||
    (
      tradingWeek.isoWeekday === CONFIG.weeklySummary.weekday &&
      currentMinutes >= scheduledMinutes
    )
  );
}

function recordWeeklyTrade(strategy, spentBaseUnits, receivedBaseUnits, tradeMeta, summaryWeek) {
  const { bucketName, bucket } = getWeeklyTradeBucket(summaryWeek);

  bucket.buyCount += 1;
  bucket.spentUsdcBaseUnits = (BigInt(bucket.spentUsdcBaseUnits) + spentBaseUnits).toString();
  bucket.receivedAidogBaseUnits = (BigInt(bucket.receivedAidogBaseUnits) + receivedBaseUnits).toString();
  bucket.strategies[strategy.id].buyCount += 1;
  bucket.strategies[strategy.id].spentUsdcBaseUnits = (
    BigInt(bucket.strategies[strategy.id].spentUsdcBaseUnits) + spentBaseUnits
  ).toString();
  bucket.strategies[strategy.id].receivedAidogBaseUnits = (
    BigInt(bucket.strategies[strategy.id].receivedAidogBaseUnits) + receivedBaseUnits
  ).toString();

  if (shouldReplaceLastTrade(bucket.lastTrade, tradeMeta.executedAtMs)) {
    bucket.lastTrade = tradeMeta;
  }

  if (
    bucketName === "previousWeekly" &&
    state.previousWeekly?.periodKey &&
    state.notifications.lastWeeklySummaryPeriodKey === state.previousWeekly.periodKey
  ) {
    logger.warn("Recovered trade updated an already-sent weekly summary", {
      periodKey: state.previousWeekly.periodKey,
      txHash: tradeMeta.txHash,
    });
    state.notifications.lastWeeklySummaryPeriodKey = "";
  }
}

function incrementWeeklyCounter(counterName) {
  if (!state.weekly) {
    state.weekly = createBlankWeeklyState(getTradingWeekInfo());
  }

  state.weekly[counterName] += 1;
  saveState();
}

async function reconcilePendingTransaction(tradingTime) {
  const pendingTx = state.pendingTx;
  if (!pendingTx) {
    return "clear";
  }

  const strategy = strategyMap[pendingTx.strategyId];
  if (!strategy) {
    logger.warn("Unknown pending transaction strategy. Clearing pending state.", pendingTx);
    clearPendingTransaction();
    return "clear";
  }

  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(pendingTx.txHash);
  } catch (error) {
    logger.error("Pending transaction receipt lookup failed", {
      ...serializeError(error),
      txHash: pendingTx.txHash,
      stage: pendingTx.stage,
      strategy: pendingTx.strategyId,
    });
    incrementWeeklyCounter("runtimeIssueCount");
    await notifier.notifyRuntimeIssue("待确认交易查询失败", [
      `钱包：${shortAddress(walletAddress)}`,
      `策略：${strategy.label}`,
      `阶段：${pendingTx.stage}`,
      `交易哈希：${pendingTx.txHash}`,
      `错误信息：${error instanceof Error ? error.message : String(error)}`,
    ], {
      throttleKey: `pending-lookup:${pendingTx.txHash}`,
    });
    return "waiting";
  }

  if (!receipt) {
    logger.warn("Pending transaction still waiting for confirmation", {
      txHash: pendingTx.txHash,
      stage: pendingTx.stage,
      strategy: pendingTx.strategyId,
      sentAt: new Date(pendingTx.sentAtMs).toISOString(),
    });
    await notifier.notifyRuntimeIssue("检测到待确认交易", [
      `钱包：${shortAddress(walletAddress)}`,
      `策略：${strategy.label}`,
      `阶段：${pendingTx.stage}`,
      `交易哈希：${pendingTx.txHash}`,
      `发送时间：${new Date(pendingTx.sentAtMs).toISOString()}`,
    ], {
      throttleKey: `pending-wait:${pendingTx.txHash}`,
      throttleMs: 15 * 60 * 1000,
    });
    return "waiting";
  }

  if (Number(receipt.status) !== 1) {
    clearPendingTransaction();
    state.runtime.lastFailureAtMs = Date.now();
    state.runtime.lastFailureReason = `${strategy.id}: pending ${pendingTx.stage} tx reverted`;
    saveState();
    incrementWeeklyCounter("failureCount");
    await notifier.notifyTradeFailure({
      wallet: shortAddress(walletAddress),
      strategy: strategy.label,
      triggerPriceUsd: Number((pendingTx.triggerPriceUsd || 0).toFixed(8)),
      attempt: CONFIG.maxTradeAttempts,
      maxAttempts: CONFIG.maxTradeAttempts,
      code: `${pendingTx.stage.toUpperCase()}_TX_REVERTED`,
      message: `待确认${pendingTx.stage === "swap" ? "换币" : "授权"}交易失败：${pendingTx.txHash}`,
      throttleKey: `pending-revert:${pendingTx.txHash}`,
      explorerUrl: `https://basescan.org/tx/${pendingTx.txHash}`,
      walletExplorerUrl: `https://basescan.org/address/${walletAddress}`,
    });
    return "clear";
  }

  if (pendingTx.stage === "approve") {
    logger.info("Recovered confirmed approval transaction", {
      strategy: strategy.id,
      txHash: pendingTx.txHash,
      blockNumber: receipt.blockNumber,
    });
    clearPendingTransaction();
    return "clear";
  }

  const walletSnapshotBefore = pendingTx.walletSnapshotBefore
    ? deserializeWalletSnapshot(pendingTx.walletSnapshotBefore)
    : null;
  const postTradeSnapshot = await getWalletSnapshot();
  const executedAtMs = await resolveReceiptExecutedAtMs(receipt, pendingTx.sentAtMs || Date.now());
  const summaryWeek = getTradingWeekInfo(new Date(executedAtMs));
  const recoveredAmounts = recoverTradeAmounts({
    receipt,
    walletAddress,
    spentTokenAddress: BASE_USDC_TOKEN_ADDRESS,
    receivedTokenAddress: AIDOG_TOKEN_ADDRESS,
    fallbackSpentBaseUnits: pendingTx.amountBaseUnits || strategy.amountBaseUnits.toString(),
    fallbackReceivedBaseUnits: pendingTx.quotedAidogBaseUnits || "0",
    walletSnapshotBefore,
    walletSnapshotAfter: postTradeSnapshot,
  });
  const normalizedPostTradeSnapshot = mergeTradeSnapshotWithRecoveredAmounts({
    walletSnapshotBefore,
    walletSnapshotAfter: postTradeSnapshot,
    spentBaseUnits: recoveredAmounts.spentBaseUnits,
    receivedBaseUnits: recoveredAmounts.receivedBaseUnits,
  });

  logger.info("Recovered swap trade amounts", {
    strategy: strategy.id,
    txHash: pendingTx.txHash,
    spentUsdc: ethers.formatUnits(recoveredAmounts.spentBaseUnits, 6),
    spentSource: recoveredAmounts.spentSource,
    receivedAidog: ethers.formatUnits(recoveredAmounts.receivedBaseUnits, 18),
    receivedSource: recoveredAmounts.receivedSource,
  });

  await recordSuccessfulTrade(
    strategy,
    {
      route: pendingTx.route || "n/a",
      receipt,
      swapHash: pendingTx.txHash,
      usdcDelta: recoveredAmounts.spentBaseUnits,
      aidogDelta: recoveredAmounts.receivedBaseUnits,
      amountSource: {
        spent: recoveredAmounts.spentSource,
        received: recoveredAmounts.receivedSource,
      },
      postTradeSnapshot: normalizedPostTradeSnapshot,
    },
    pendingTx.triggerPriceUsd || 0,
    {
      dayKey: pendingTx.tradingDayKey || tradingTime.dayKey,
      executedAtMs,
      summaryWeek,
    },
  );

  logger.info("Recovered confirmed swap transaction", {
    strategy: strategy.id,
    txHash: pendingTx.txHash,
    blockNumber: receipt.blockNumber,
  });

  if (CONFIG.buyOnce) {
    logger.info("BUY_ONCE enabled, exiting after recovered successful trade");
    return "stop";
  }

  return "clear";
}

function evaluateStrategies(currentPrice, tradingTime) {
  const signals = [];
  const skips = [];

  const deepBuySignal = evaluateDeepDiscountStrategy(currentPrice);
  if (deepBuySignal.signal) {
    signals.push(deepBuySignal.signal);
  }
  if (deepBuySignal.skip) {
    skips.push(deepBuySignal.skip);
  }

  const dailyDcaSignal = evaluateDailyDcaStrategy(currentPrice, tradingTime);
  if (dailyDcaSignal.signal) {
    signals.push(dailyDcaSignal.signal);
  }
  if (dailyDcaSignal.skip) {
    skips.push(dailyDcaSignal.skip);
  }

  signals.sort((a, b) => strategyPriority.indexOf(a.id) - strategyPriority.indexOf(b.id));
  return { signals, skips };
}

function evaluateDailyDcaStrategy(currentPrice, tradingTime) {
  const strategy = strategyMap.daily_dca;
  if (!strategy.enabled) {
    return {};
  }

  if (currentPrice > strategy.thresholdUsd) {
    return {};
  }

  if (hasHandledDailyDcaForDay(state.strategies.daily_dca, tradingTime.dayKey)) {
    return {};
  }

  const currentMinutes = tradingTime.hour * 60 + tradingTime.minute;
  const scheduledMinutes = CONFIG.dailyDca.hour * 60 + CONFIG.dailyDca.minute;
  if (
    currentMinutes < scheduledMinutes ||
    currentMinutes >= scheduledMinutes + CONFIG.dailyDca.windowMinutes
  ) {
    return {};
  }

  return { signal: strategy };
}

function evaluateDeepDiscountStrategy(currentPrice) {
  const strategy = strategyMap.deep_discount_buy;
  if (!strategy.enabled) {
    return {};
  }

  if (currentPrice > strategy.thresholdUsd) {
    return {};
  }

  const cooldownMs = CONFIG.deepBuy.cooldownDays * 24 * 60 * 60 * 1000;
  const lastExecutedAtMs = state.strategies.deep_discount_buy.lastExecutedAtMs;
  if (lastExecutedAtMs && Date.now() - lastExecutedAtMs < cooldownMs) {
      return {
        skip: {
          signature: "deep-buy-cooldown",
          message: "深跌加仓跳过：冷却时间未结束。",
          context: {
            nextEligibleAt: new Date(lastExecutedAtMs + cooldownMs).toISOString(),
            cooldownDays: CONFIG.deepBuy.cooldownDays,
        },
      },
    };
  }

  return { signal: strategy };
}

async function processSkipEvents(skips) {
  const nextActive = new Set(skips.map((skip) => skip.signature));
  for (const skip of skips) {
    if (activeSkipSignatures.has(skip.signature)) {
      continue;
    }

    logger.warn(skip.message, skip.context);
    if (skip.signature === "deep-buy-cooldown") {
      await notifier.notifyGuard(skip.message, [
        `钱包：${shortAddress(walletAddress)}`,
        `详情：${JSON.stringify(skip.context)}`,
      ], {
        throttleKey: skip.signature,
        guardType: skip.signature,
      });
    }
  }

  activeSkipSignatures = nextActive;
}

async function recordSuccessfulTrade(strategy, trade, triggerPrice, tradingTime, options = {}) {
  const spent = BigInt(trade.usdcDelta);
  const received = BigInt(trade.aidogDelta);
  const executedAtMs = Number(options.executedAtMs || Date.now());
  const summaryWeek = options.summaryWeek || getTradingWeekInfo(new Date(executedAtMs));
  const tradeMeta = {
    executedAtMs,
    strategyId: strategy.id,
    strategyLabel: strategy.label,
    txHash: trade.swapHash,
    spentUsdc: ethers.formatUnits(spent, 6),
    receivedAidog: ethers.formatUnits(received, 18),
    blockNumber: trade.receipt.blockNumber,
  };

  clearFailureState();
  clearPendingTransaction();
  state.daily.buyCount += 1;
  state.daily.spentUsdcBaseUnits = (BigInt(state.daily.spentUsdcBaseUnits) + spent).toString();
  state.daily.receivedAidogBaseUnits = (
    BigInt(state.daily.receivedAidogBaseUnits) + received
  ).toString();
  recordWeeklyTrade(strategy, spent, received, tradeMeta, summaryWeek);

  if (strategy.id === "daily_dca") {
    state.strategies.daily_dca = clearDailyDcaSkip(state.strategies.daily_dca);
    state.strategies.daily_dca.lastExecutedDayKey = tradingTime.dayKey;
    state.strategies.daily_dca.lastSuccessAtMs = executedAtMs;
    state.strategies.daily_dca.lastSuccessTxHash = trade.swapHash;
  }

  if (strategy.id === "deep_discount_buy") {
    state.strategies.deep_discount_buy.lastExecutedAtMs = executedAtMs;
    state.strategies.deep_discount_buy.lastSuccessTxHash = trade.swapHash;
  }

  if (shouldReplaceLastTrade(state.lastTrade, executedAtMs)) {
    state.lastTrade = {
      executedAtMs,
      strategyId: strategy.id,
      strategyLabel: strategy.label,
      triggerPriceUsd: triggerPrice,
      txHash: trade.swapHash,
      spentUsdc: ethers.formatUnits(spent, 6),
      receivedAidog: ethers.formatUnits(received, 18),
      route: trade.route || "n/a",
      blockNumber: trade.receipt.blockNumber,
    };
  }

  saveState();

  logger.trade("buy-filled", {
    strategy: strategy.id,
    txHash: trade.swapHash,
    blockNumber: trade.receipt.blockNumber,
    spentUsdc: ethers.formatUnits(spent, 6),
    receivedAidog: ethers.formatUnits(received, 18),
    spentSource: trade.amountSource?.spent || "balance-delta",
    receivedSource: trade.amountSource?.received || "balance-delta",
    gasUsed: trade.receipt.gasUsed.toString(),
    triggerPriceUsd: triggerPrice,
    route: trade.route || "n/a",
    walletUsdcAfter: ethers.formatUnits(trade.postTradeSnapshot.usdcBalance, 6),
    walletAidogAfter: ethers.formatUnits(trade.postTradeSnapshot.aidogBalance, 18),
  });

  await notifier.notifyTradeSuccess({
    strategyId: strategy.id,
    wallet: shortAddress(walletAddress),
    strategy: strategy.label,
    triggerPriceUsd: Number(triggerPrice.toFixed(8)),
    txHash: trade.swapHash,
    explorerUrl: `https://basescan.org/tx/${trade.swapHash}`,
    spentUsdc: ethers.formatUnits(spent, 6),
    receivedAidog: ethers.formatUnits(received, 18),
    route: trade.route || "n/a",
    walletUsdcAfter: ethers.formatUnits(trade.postTradeSnapshot.usdcBalance, 6),
    walletAidogAfter: ethers.formatUnits(trade.postTradeSnapshot.aidogBalance, 18),
    dailyBuyCount: state.daily.buyCount,
    walletExplorerUrl: `https://basescan.org/address/${walletAddress}`,
  });
}

async function getWalletSnapshot() {
  const [baseEthBalance, usdcBalance, aidogBalance] = await Promise.all([
    provider.getBalance(walletAddress),
    readErc20Uint256(BASE_USDC_TOKEN_ADDRESS, "balanceOf", [walletAddress]),
    readErc20Uint256(AIDOG_TOKEN_ADDRESS, "balanceOf", [walletAddress]),
  ]);

  return {
    baseEthBalance,
    usdcBalance,
    aidogBalance,
  };
}

function enforceWalletGuards(strategy, walletSnapshot) {
  if (walletSnapshot.baseEthBalance < minBaseEthBalanceWei) {
    throw createBotError(
      "LOW_GAS_BALANCE",
      `Base ETH balance ${ethers.formatEther(walletSnapshot.baseEthBalance)} is below MIN_BASE_ETH_BALANCE ${CONFIG.minBaseEthBalance}.`,
    );
  }

  if (walletSnapshot.usdcBalance < strategy.amountBaseUnits) {
    throw createBotError(
      "INSUFFICIENT_USDC",
      `Need ${strategy.amountUsdc} USDC for ${strategy.label} but only have ${ethers.formatUnits(walletSnapshot.usdcBalance, 6)}.`,
    );
  }

  if (maxAidogBalanceBaseUnits && walletSnapshot.aidogBalance >= maxAidogBalanceBaseUnits) {
    throw createBotError(
      "MAX_AIDOG_BALANCE_REACHED",
      `AIDOG balance ${ethers.formatUnits(walletSnapshot.aidogBalance, 18)} reached MAX_AIDOG_BALANCE ${CONFIG.maxAidogBalance}.`,
    );
  }

  if (state.daily.buyCount >= CONFIG.maxBuysPerDay) {
    throw createBotError(
      "DAILY_COUNT_LIMIT",
      `Daily trade count limit ${CONFIG.maxBuysPerDay} has been reached.`,
    );
  }

  const spentToday = BigInt(state.daily.spentUsdcBaseUnits);
  if (spentToday + strategy.amountBaseUnits > dailyBuyBudgetBaseUnits) {
    throw createBotError(
      "DAILY_BUDGET_LIMIT",
      `Daily USDC budget ${CONFIG.dailyBuyBudgetUsdc} would be exceeded.`,
    );
  }
}

function validateQuote(quote) {
  if (quote.toToken.isHoneyPot || quote.fromToken.isHoneyPot) {
    throw createBotError("HONEYPOT", "Swap quote flagged a honeypot token.");
  }

  const priceImpact = Math.abs(Number(quote.priceImpactPercent));
  if (priceImpact > CONFIG.maxPriceImpactPercent) {
    throw createBotError(
      "PRICE_IMPACT_LIMIT",
      `Price impact ${formatPercent(priceImpact)} exceeds limit ${formatPercent(CONFIG.maxPriceImpactPercent)}.`,
    );
  }

  const taxRate = Number(quote.toToken.taxRate);
  if (taxRate > CONFIG.maxTaxRate) {
    throw createBotError(
      "TAX_LIMIT",
      `Token tax rate ${formatPercent(taxRate * 100)} exceeds limit ${formatPercent(CONFIG.maxTaxRate * 100)}.`,
    );
  }
}

function resolveWalletAddress() {
  if (baseWallet && CONFIG.configuredWalletAddress) {
    const normalizedConfigured = ethers.getAddress(CONFIG.configuredWalletAddress);
    if (baseWallet.address !== normalizedConfigured) {
      throw createBotError(
        "BAD_CONFIG",
        "BASE_WALLET_ADDRESS does not match BASE_PRIVATE_KEY.",
      );
    }
  }

  if (baseWallet) {
    return baseWallet.address;
  }

  if (CONFIG.configuredWalletAddress) {
    return ethers.getAddress(CONFIG.configuredWalletAddress);
  }

  throw createBotError(
    "BAD_CONFIG",
    "Set BASE_WALLET_ADDRESS for dry runs, or BASE_PRIVATE_KEY for live trading.",
  );
}

async function readErc20Uint256(contractAddress, functionName, args) {
  const callData = erc20Interface.encodeFunctionData(functionName, args);

  for (let attempt = 0; attempt <= CONFIG.maxTradeAttempts + 1; attempt += 1) {
    try {
      const result = await provider.send("eth_call", [
        {
          to: contractAddress,
          data: callData,
        },
        "latest",
      ]);

      const [decoded] = erc20Interface.decodeFunctionResult(functionName, result);
      return decoded;
    } catch (error) {
      if (attempt >= CONFIG.maxTradeAttempts + 1 || !isRetryableRpcError(error)) {
        throw error;
      }

      await sleep(CONFIG.tradeRetryBaseMs * (attempt + 1));
    }
  }

  throw new Error("RPC call exhausted retries");
}

function handleStop() {
  stopped = true;
}

function clearFailureState() {
  state.runtime.lastFailureAtMs = 0;
  state.runtime.lastFailureReason = "";
}

function createBotError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  return error;
}

function isRetryableTradeError(error) {
  if (!error) {
    return false;
  }

  if (error.retryable === false) {
    return false;
  }

  const text = `${error.code || ""} ${error.shortMessage || ""} ${error.message || ""}`;
  return /HTTP 429|50011|fetch failed|timeout|timed out|CALL_EXCEPTION|execution reverted|replacement fee too low|NONCE_EXPIRED|nonce too low|nonce has already been used/i.test(
    text,
  );
}

function isRetryableRpcError(error) {
  const text = `${error?.code || ""} ${error?.shortMessage || ""} ${error?.message || ""}`;
  return /429|timeout|timed out|too many requests|network/i.test(text);
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      code: error.code || "",
      message: error.message,
      shortMessage: error.shortMessage || "",
    };
  }

  return {
    message: String(error),
  };
}

function padGasLimit(value) {
  return BigInt(Math.ceil(Number(value) * CONFIG.gasLimitMultiplier));
}

async function sendTransactionWithSyncedNonce(txRequest) {
  if (!signer) {
    throw createBotError("MISSING_PRIVATE_KEY", "BASE_PRIVATE_KEY is required when DRY_RUN=false.");
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    resetSignerNonce();
    try {
      return await signer.sendTransaction(txRequest);
    } catch (error) {
      if (!shouldResetSignerNonce(error) || attempt >= 2) {
        throw error;
      }

      logger.warn("Retrying transaction after nonce reset", {
        attempt,
        ...serializeError(error),
      });
      await sleep(CONFIG.tradeRetryBaseMs);
    }
  }

  throw new Error("Transaction send exhausted retries");
}

function resetSignerNonce() {
  if (!signer) {
    return;
  }

  signer.reset();
}

function shouldResetSignerNonce(error) {
  const text = `${error?.code || ""} ${error?.shortMessage || ""} ${error?.message || ""}`;
  return /NONCE_EXPIRED|nonce too low|nonce has already been used/i.test(text);
}

async function notifyTradeFailure(strategy, error, triggerPrice, attempt) {
  const details = serializeError(error);
  const guardCodes = new Set([
    "LOW_GAS_BALANCE",
    "INSUFFICIENT_USDC",
    "MAX_AIDOG_BALANCE_REACHED",
    "BAD_CONFIG",
    "DAILY_COUNT_LIMIT",
    "DAILY_BUDGET_LIMIT",
  ]);

  if (guardCodes.has(details.code)) {
    incrementWeeklyCounter("guardCount");
    await notifier.notifyGuard("风控拦截，未执行交易", [
      `钱包：${shortAddress(walletAddress)}`,
      `策略：${strategy.label}`,
      `价格：${Number(triggerPrice.toFixed(8))} USD`,
      `错误码：${details.code}`,
      `错误信息：${details.message}`,
    ], {
      throttleKey: `guard:${strategy.id}:${details.code}`,
    });
    return;
  }

  incrementWeeklyCounter("failureCount");
  await notifier.notifyTradeFailure({
    wallet: shortAddress(walletAddress),
    strategy: strategy.label,
    triggerPriceUsd: Number(triggerPrice.toFixed(8)),
    attempt,
    maxAttempts: CONFIG.maxTradeAttempts,
    code: details.code,
    message: details.message,
    walletExplorerUrl: `https://basescan.org/address/${walletAddress}`,
    throttleKey: `trade-failure:${strategy.id}:${details.code || "unknown"}`,
  });
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatWeekTitle(weekStartDayKey) {
  const weekStart = new Date(`${weekStartDayKey}T00:00:00.000Z`);
  if (Number.isNaN(weekStart.getTime())) {
    return String(weekStartDayKey || "每周汇总");
  }

  const isoWeekYear = weekStart.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoWeekYear, 0, 4));
  const firstWeekday = firstThursday.getUTCDay() || 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - (firstWeekday - 1));

  const diffDays = Math.round((weekStart.getTime() - firstThursday.getTime()) / 86400000);
  const weekNumber = Math.floor(diffDays / 7) + 1;

  return `${isoWeekYear}-W${pad2(weekNumber)}`;
}
