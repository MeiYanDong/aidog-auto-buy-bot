import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createFeishuNotifier } from "./lib/feishu-notifier.mjs";
import { loadDotEnv } from "./lib/okx-onchainos.mjs";
import { ensureDirectory } from "./lib/runtime.mjs";

loadDotEnv();

const mode = getArgValue("--mode") || "mock";

if (mode === "mock") {
  await runMockTest();
} else if (mode === "live") {
  await runLiveTest();
} else {
  throw new Error(`Unsupported mode: ${mode}`);
}

async function runMockTest() {
  const receivedPayloads = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      receivedPayloads.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: 0, msg: "ok" }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const webhookUrl = `http://127.0.0.1:${address.port}/hook`;

  try {
    const notifier = createTestNotifier({
      webhookUrl,
      secret: "mock-feishu-secret",
      botName: "AIDOG Bot 测试",
    });

    const results = await sendAllMessageKinds(notifier);
    assert.equal(receivedPayloads.length, 7, "Expected 7 card messages in mock mode.");
    assert.ok(results.every((item) => item.sent), "Every mock message should be sent.");
    validatePayloads(receivedPayloads);

    const dryRunStartupNotifier = createTestNotifier({
      webhookUrl,
      botName: "AIDOG Bot 测试",
      isDryRun: true,
      notifyDryRun: false,
    });
    const suppressed = await dryRunStartupNotifier.notifyLifecycle("机器人已启动", [
      "钱包：0xTEST...0001",
    ]);
    assert.equal(suppressed, false, "Dry-run startup should be suppressed.");
    assert.equal(receivedPayloads.length, 7, "Suppressed startup should not send any extra payload.");

    const filteredTradeNotifier = createTestNotifier({
      webhookUrl,
      botName: "AIDOG Bot 测试",
      notifyDailyDcaSuccess: false,
      notifyDeepBuySuccess: true,
    });
    const suppressedDailyDcaSuccess = await filteredTradeNotifier.notifyTradeSuccess({
      wallet: "0xE4d5...0B6d",
      strategyId: "daily_dca",
      strategy: "每日定投（测试）",
      triggerPriceUsd: 0.00456,
      txHash: "0xtestdca123",
      explorerUrl: "https://basescan.org/tx/0xtestdca123",
      spentUsdc: "2.0",
      receivedAidog: "440.123456789",
      route: "PancakeSwap V3 -> Uniswap V2",
      walletUsdcAfter: "14.0",
      walletAidogAfter: "880.289620754737618887",
      dailyBuyCount: 1,
      walletExplorerUrl: "https://basescan.org/address/0xE4d5bE169574FC9E18Edaa813790f079e1630B6d",
    });
    assert.equal(
      suppressedDailyDcaSuccess,
      false,
      "Daily DCA success should be suppressed when notifyDailyDcaSuccess=false.",
    );
    assert.equal(receivedPayloads.length, 7, "Suppressed daily DCA success should not send any extra payload.");

    const filteredGuardNotifier = createTestNotifier({
      webhookUrl,
      botName: "AIDOG Bot 测试",
      notifyDeepBuyCooldownSkip: false,
    });
    const suppressedCooldownGuard = await filteredGuardNotifier.notifyGuard("深跌加仓跳过：冷却时间未结束。", [
      "钱包：0xE4d5...0B6d",
      "详情：{\"nextEligibleAt\":\"2026-03-10T00:00:00.000Z\",\"cooldownDays\":5}",
    ], {
      guardType: "deep-buy-cooldown",
      throttleKey: `test-cooldown-guard-${Date.now()}`,
      throttleMs: 0,
    });
    assert.equal(
      suppressedCooldownGuard,
      false,
      "Deep-buy cooldown guard should be suppressed when notifyDeepBuyCooldownSkip=false.",
    );
    assert.equal(receivedPayloads.length, 7, "Suppressed cooldown guard should not send any extra payload.");

    const outputPath = path.resolve("data/logs/feishu-card-test-mock.json");
    ensureDirectory(path.dirname(outputPath));
    fs.writeFileSync(
      outputPath,
      `${JSON.stringify(
        {
          mode: "mock",
          checkedAt: new Date().toISOString(),
          results,
          receivedPayloads,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    console.log(`Mock test passed. Captured 7 card payloads at ${outputPath}`);
    for (const [index, payload] of receivedPayloads.entries()) {
      console.log(`${index + 1}. ${payload.card.header.title.content}`);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function runLiveTest() {
  if (!process.env.FEISHU_WEBHOOK_URL) {
    throw new Error("FEISHU_WEBHOOK_URL is required for live mode.");
  }

  const notifier = createTestNotifier({
    webhookUrl: process.env.FEISHU_WEBHOOK_URL,
    secret: process.env.FEISHU_SECRET || "",
    botName: "AIDOG Bot 测试",
  });

  const results = await sendAllMessageKinds(notifier);
  const failed = results.filter((item) => !item.sent);
  if (failed.length > 0) {
    throw new Error(`Live Feishu test failed for: ${failed.map((item) => item.kind).join(", ")}`);
  }

  const outputPath = path.resolve("data/logs/feishu-card-test-live.json");
  ensureDirectory(path.dirname(outputPath));
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        mode: "live",
        checkedAt: new Date().toISOString(),
        results,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log("Live Feishu test passed. Sent 7 card messages to the configured webhook.");
  for (const result of results) {
    console.log(`${result.kind}: sent`);
  }
}

function createTestNotifier(overrides = {}) {
  return createFeishuNotifier(
    {
      webhookUrl: "",
      secret: "",
      botName: "AIDOG Bot 测试",
      isDryRun: false,
      notificationCooldownMs: 0,
      notifyStartup: true,
      notifyTradeSuccess: true,
      notifyTradeFailure: true,
      notifyRuntimeIssues: true,
      notifyGuardEvents: true,
      notifyDryRun: true,
      notifyWeeklySummary: true,
      notifyDailyDcaSuccess: true,
      notifyDeepBuySuccess: true,
      notifyDeepBuyCooldownSkip: true,
      ...overrides,
    },
    {
      warn() {},
      info() {},
      error() {},
    },
  );
}

async function sendAllMessageKinds(notifier) {
  const results = [];

  results.push({
    kind: "lifecycle",
    sent: await notifier.notifyLifecycle("机器人已启动", [
      "钱包：0xE4d5...0B6d",
      "时区：Asia/Shanghai",
      "每日定投：低于等于 0.005 USD，买入 2 USDC，时间 24:00",
      "深跌加仓：低于等于 0.004 USD，买入 10 USDC，冷却 5 天",
      "模拟模式：关闭",
    ], {
      actions: [
        {
          text: "查看钱包",
          url: "https://basescan.org/address/0xE4d5bE169574FC9E18Edaa813790f079e1630B6d",
          type: "default",
        },
      ],
    }),
  });

  results.push({
    kind: "trade-success",
    sent: await notifier.notifyTradeSuccess({
      wallet: "0xE4d5...0B6d",
      strategyId: "deep_discount_buy",
      strategy: "深跌加仓（测试）",
      triggerPriceUsd: 0.00456,
      txHash: "0xtestsuccess123",
      explorerUrl: "https://basescan.org/tx/0xtestsuccess123",
      spentUsdc: "2.0",
      receivedAidog: "440.123456789",
      route: "PancakeSwap V3 -> Uniswap V2",
      walletUsdcAfter: "14.0",
      walletAidogAfter: "880.289620754737618887",
      dailyBuyCount: 1,
      walletExplorerUrl: "https://basescan.org/address/0xE4d5bE169574FC9E18Edaa813790f079e1630B6d",
    }),
  });

  results.push({
    kind: "trade-failure",
    sent: await notifier.notifyTradeFailure({
      wallet: "0xE4d5...0B6d",
      strategy: "深跌加仓（测试）",
      triggerPriceUsd: 0.00398,
      attempt: 2,
      maxAttempts: 2,
      code: "HTTP_429",
      message: "报价接口限流，已达到最大重试次数。",
      explorerUrl: "https://basescan.org/tx/0xtestfailure123",
      walletExplorerUrl: "https://basescan.org/address/0xE4d5bE169574FC9E18Edaa813790f079e1630B6d",
      throttleKey: `test-trade-failure-${Date.now()}`,
    }),
  });

  results.push({
    kind: "runtime-issue",
    sent: await notifier.notifyRuntimeIssue("价格查询失败", [
      "钱包：0xE4d5...0B6d",
      "错误信息：OKX market price request timed out.",
    ], {
      throttleKey: `test-runtime-${Date.now()}`,
      throttleMs: 0,
    }),
  });

  results.push({
    kind: "guard",
    sent: await notifier.notifyGuard("风控拦截，未执行交易", [
      "钱包：0xE4d5...0B6d",
      "策略：深跌加仓（测试）",
      "价格：0.00399 USD",
      "错误码：DAILY_BUDGET_LIMIT",
      "错误信息：Daily USDC budget 12 would be exceeded.",
    ], {
      throttleKey: `test-guard-${Date.now()}`,
      throttleMs: 0,
    }),
  });

  results.push({
    kind: "dry-run",
    sent: await notifier.notifyDryRun({
      wallet: "0xE4d5...0B6d",
      strategy: "每日定投（模拟）",
      triggerPriceUsd: 0.00457,
      buyAmountUsdc: "2",
      expectedAidog: "439.88",
      route: "TesseraEvm -> Uniswap V2",
      needsApproval: true,
      walletUsdc: "16.0",
      walletAidog: "440.166163965737618887",
      walletExplorerUrl: "https://basescan.org/address/0xE4d5bE169574FC9E18Edaa813790f079e1630B6d",
    }),
  });

  results.push({
    kind: "weekly-summary",
    sent: await notifier.notifyWeeklySummary({
      periodLabel: "2026-02-23 ~ 2026-03-01",
      totalBuyCount: 3,
      totalSpentUsdc: "14.0",
      totalReceivedAidog: "3080.55",
      dailyDcaBuyCount: 2,
      dailyDcaSpentUsdc: "4.0",
      dailyDcaReceivedAidog: "880.11",
      deepBuyCount: 1,
      deepBuySpentUsdc: "10.0",
      deepBuyReceivedAidog: "2200.44",
      failureCount: 1,
      guardCount: 2,
      runtimeIssueCount: 1,
      currentEth: "0.00049",
      currentUsdc: "16.0",
      currentAidog: "440.166163965737618887",
      currentPriceUsd: "0.00456",
      lastTrade: {
        strategyLabel: "深跌加仓（测试）",
        txHash: "0xtestweekly123",
        spentUsdc: "10.0",
        receivedAidog: "2200.44",
      },
      walletExplorerUrl: "https://basescan.org/address/0xE4d5bE169574FC9E18Edaa813790f079e1630B6d",
    }),
  });

  return results;
}

function validatePayloads(payloads) {
  for (const payload of payloads) {
    assert.equal(payload.msg_type, "interactive");
    assert.ok(payload.card, "Missing card object.");
    assert.equal(payload.card.header.title.tag, "plain_text");
    assert.ok(Array.isArray(payload.card.elements) && payload.card.elements.length > 1);
    assert.ok(payload.timestamp, "Signed payload should include timestamp.");
    assert.ok(payload.sign, "Signed payload should include sign.");
  }

  const tradeSuccessText = collectCardText(
    payloads.find((payload) => payload.card.header.title.content.includes("买入成功")),
  );
  assert.match(tradeSuccessText, /收到\s+440 AIDOG/);
  assert.match(tradeSuccessText, /交易后 AIDOG\s+880/);

  const dryRunText = collectCardText(
    payloads.find((payload) => payload.card.header.title.content.includes("模拟触发")),
  );
  assert.match(dryRunText, /预计收到\s+439 AIDOG/);
  assert.match(dryRunText, /钱包 AIDOG\s+440/);

  const weeklySummaryText = collectCardText(
    payloads.find((payload) => payload.card.header.title.content.includes("每周汇总")),
  );
  assert.match(weeklySummaryText, /总收到\s+3080 AIDOG/);
  assert.match(weeklySummaryText, /每日定投\s+2 次 \/ 4\.0 USDC \/ 880 AIDOG/);
  assert.match(weeklySummaryText, /深跌加仓\s+1 次 \/ 10\.0 USDC \/ 2200 AIDOG/);
  assert.match(weeklySummaryText, /当前 AIDOG\s+440/);
  assert.match(weeklySummaryText, /最近成交\s+深跌加仓（测试） \/ 10\.0 USDC \/ 2200 AIDOG/);

  assert.ok(
    payloads.some((payload) =>
      payload.card.elements.some((element) => element.tag === "action" && Array.isArray(element.actions) && element.actions.length > 0),
    ),
    "Expected at least one card action button.",
  );
}

function getArgValue(name) {
  const arg = process.argv.find((item) => item.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : "";
}

function collectCardText(payload) {
  return payload.card.elements
    .flatMap((element) => {
      if (element.text?.content) {
        return [element.text.content];
      }

      if (Array.isArray(element.fields)) {
        return element.fields
          .map((field) => field?.text?.content)
          .filter(Boolean);
      }

      return [];
    })
    .join("\n");
}
