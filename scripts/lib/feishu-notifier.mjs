import crypto from "node:crypto";

export function createFeishuNotifier(config, logger) {
  const throttleState = new Map();

  return {
    enabled: Boolean(config.webhookUrl),
    async notifyLifecycle(title, lines, options = {}) {
      if (!config.notifyStartup) {
        return false;
      }

      if (config.isDryRun && !config.notifyDryRun && options.skipWhenDryRun !== false) {
        return false;
      }

      return send(title, lines, {
        actions: options.actions || [],
        template: "blue",
        throttleKey: options.throttleKey || title,
        throttleMs: options.throttleMs ?? 0,
      });
    },
    async notifyTradeSuccess(payload) {
      if (!config.notifyTradeSuccess) {
        return false;
      }

      return send("买入成功", [
        `钱包：${payload.wallet}`,
        `策略：${payload.strategy}`,
        `触发价格：${payload.triggerPriceUsd} USD`,
        `花费：${payload.spentUsdc} USDC`,
        `收到：${payload.receivedAidog} AIDOG`,
        `路由：${payload.route}`,
        `交易哈希：${payload.txHash}`,
        `浏览器：${payload.explorerUrl}`,
        `交易后 USDC：${payload.walletUsdcAfter}`,
        `交易后 AIDOG：${payload.walletAidogAfter}`,
        `当日买入次数：${payload.dailyBuyCount}`,
      ], {
        actions: buildTradeActions(payload),
        template: "green",
      });
    },
    async notifyTradeFailure(payload) {
      if (!config.notifyTradeFailure) {
        return false;
      }

      return send("买入失败", [
        `钱包：${payload.wallet}`,
        `策略：${payload.strategy}`,
        `价格：${payload.triggerPriceUsd} USD`,
        `尝试次数：${payload.attempt}/${payload.maxAttempts}`,
        `错误码：${payload.code || "n/a"}`,
        `错误信息：${payload.message}`,
      ], {
        actions: buildTradeActions(payload),
        template: "red",
        throttleKey: payload.throttleKey || `trade-failure:${payload.code || "unknown"}`,
      });
    },
    async notifyRuntimeIssue(title, lines, options = {}) {
      if (!config.notifyRuntimeIssues) {
        return false;
      }

      return send(title, lines, {
        actions: options.actions || [],
        template: "orange",
        throttleKey: options.throttleKey || title,
        throttleMs: options.throttleMs,
      });
    },
    async notifyGuard(title, lines, options = {}) {
      if (!config.notifyGuardEvents) {
        return false;
      }

      return send(title, lines, {
        actions: options.actions || [],
        template: "red",
        throttleKey: options.throttleKey || title,
        throttleMs: options.throttleMs,
      });
    },
    async notifyDryRun(payload) {
      if (!config.notifyDryRun) {
        return false;
      }

      return send("模拟触发", [
        `钱包：${payload.wallet}`,
        `策略：${payload.strategy}`,
        `触发价格：${payload.triggerPriceUsd} USD`,
        `买入金额：${payload.buyAmountUsdc} USDC`,
        `预计收到：${payload.expectedAidog} AIDOG`,
        `路由：${payload.route}`,
        `需要授权：${payload.needsApproval ? "是" : "否"}`,
        `钱包 USDC：${payload.walletUsdc}`,
        `钱包 AIDOG：${payload.walletAidog}`,
      ], {
        actions: buildTradeActions(payload),
        template: "grey",
        throttleKey: "dry-run-trigger",
        throttleMs: config.notificationCooldownMs,
      });
    },
    async notifyWeeklySummary(payload) {
      if (!config.notifyWeeklySummary) {
        return false;
      }

      const lines = [
        `统计周期：${payload.periodLabel}`,
        `总买入次数：${payload.totalBuyCount}`,
        `总花费：${payload.totalSpentUsdc} USDC`,
        `总收到：${payload.totalReceivedAidog} AIDOG`,
        `每日定投：${payload.dailyDcaBuyCount} 次 / ${payload.dailyDcaSpentUsdc} USDC / ${payload.dailyDcaReceivedAidog} AIDOG`,
        `深跌加仓：${payload.deepBuyCount} 次 / ${payload.deepBuySpentUsdc} USDC / ${payload.deepBuyReceivedAidog} AIDOG`,
        `失败次数：${payload.failureCount}`,
        `风控拦截：${payload.guardCount}`,
        `运行异常：${payload.runtimeIssueCount}`,
        `当前 ETH：${payload.currentEth}`,
        `当前 USDC：${payload.currentUsdc}`,
        `当前 AIDOG：${payload.currentAidog}`,
        `当前价格：${payload.currentPriceUsd} USD`,
      ];

      if (payload.lastTrade?.txHash) {
        lines.push(
          `最近成交：${payload.lastTrade.strategyLabel} / ${payload.lastTrade.spentUsdc} USDC / ${payload.lastTrade.receivedAidog} AIDOG`,
        );
        lines.push(`最近成交哈希：${payload.lastTrade.txHash}`);
      }

      return send("每周汇总", lines, {
        actions: buildWeeklySummaryActions(payload),
        template: "blue",
        throttleKey: `weekly-summary:${payload.periodLabel}`,
        throttleMs: 0,
      });
    },
  };

  async function send(title, lines, options) {
    if (!config.webhookUrl) {
      return false;
    }

    const throttleKey = options?.throttleKey || null;
    const throttleMs = options?.throttleMs ?? config.notificationCooldownMs;
    if (throttleKey && throttleMs > 0) {
      const lastSentAt = throttleState.get(throttleKey) || 0;
      if (Date.now() - lastSentAt < throttleMs) {
        return false;
      }
    }

    const payload = buildPayload(config, title, lines, options);

    try {
      const response = await fetch(config.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json().catch(() => ({}));
      if (result.code && String(result.code) !== "0") {
        throw new Error(`Feishu response ${result.code}: ${result.msg || "unknown error"}`);
      }

      if (throttleKey && throttleMs > 0) {
        throttleState.set(throttleKey, Date.now());
      }

      return true;
    } catch (error) {
      if (logger) {
        logger.warn("Feishu notification failed", {
          title,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      return false;
    }
  }
}

function buildPayload(config, title, lines, options = {}) {
  const body = {
    msg_type: "interactive",
    card: buildCard(config, title, lines, options),
  };

  if (!config.secret) {
    return body;
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const stringToSign = `${timestamp}\n${config.secret}`;
  const sign = crypto.createHmac("sha256", stringToSign).update("").digest("base64");

  return {
    ...body,
    timestamp,
    sign,
  };
}

function buildCard(config, title, lines, options) {
  const elements = [];
  const bufferedShortFields = [];

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) {
      continue;
    }

    const parsed = parseLine(line);
    if (parsed.type === "field") {
      const field = {
        is_short: parsed.isShort,
        text: {
          tag: "plain_text",
          content: `${parsed.label}\n${parsed.value}`,
        },
      };

      if (parsed.isShort) {
        bufferedShortFields.push(field);
        if (bufferedShortFields.length === 2) {
          elements.push({
            tag: "div",
            fields: bufferedShortFields.splice(0, bufferedShortFields.length),
          });
        }
      } else {
        flushShortFields(elements, bufferedShortFields);
        elements.push({
          tag: "div",
          fields: [field],
        });
      }
      continue;
    }

    flushShortFields(elements, bufferedShortFields);
    elements.push({
      tag: "div",
      text: {
        tag: "plain_text",
        content: parsed.content,
      },
    });
  }

  flushShortFields(elements, bufferedShortFields);

  if (Array.isArray(options.actions) && options.actions.length > 0) {
    elements.push({
      tag: "action",
      actions: options.actions.map((action) => ({
        tag: "button",
        type: action.type || "default",
        text: {
          tag: "plain_text",
          content: action.text,
        },
        url: action.url,
      })),
    });
  }

  if (elements.length === 0) {
    elements.push({
      tag: "div",
      text: {
        tag: "plain_text",
        content: title,
      },
    });
  }

  elements.push({ tag: "hr" });
  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: `${config.botName} · 发送时间 ${formatCardTime(new Date())}`,
      },
    ],
  });

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: options.template || "blue",
      title: {
        tag: "plain_text",
        content: `[${config.botName}] ${title}`,
      },
    },
    elements,
  };
}

function flushShortFields(elements, bufferedShortFields) {
  if (bufferedShortFields.length === 0) {
    return;
  }

  elements.push({
    tag: "div",
    fields: bufferedShortFields.splice(0, bufferedShortFields.length),
  });
}

function parseLine(line) {
  const match = line.match(/^([^:：]+)[:：]\s*(.+)$/s);
  if (!match) {
    return {
      type: "text",
      content: line,
    };
  }

  const label = match[1].trim();
  const value = match[2].trim();

  return {
    type: "field",
    label,
    value,
    isShort: isShortField(label, value),
  };
}

function isShortField(label, value) {
  const normalized = `${label} ${value}`;
  return (
    normalized.length <= 48 &&
    !/https?:\/\//i.test(value) &&
    !/->/.test(value) &&
    !/[{}\[\]]/.test(value)
  );
}

function formatCardTime(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function buildTradeActions(payload) {
  const actions = [];

  if (payload.explorerUrl) {
    actions.push({
      text: "查看交易",
      type: "primary",
      url: payload.explorerUrl,
    });
  }

  if (payload.walletExplorerUrl) {
    actions.push({
      text: "查看钱包",
      type: actions.length === 0 ? "primary" : "default",
      url: payload.walletExplorerUrl,
    });
  }

  return actions;
}

function buildWeeklySummaryActions(payload) {
  const actions = [];

  if (payload.lastTrade?.txHash) {
    actions.push({
      text: "查看最近成交",
      type: "primary",
      url: `https://basescan.org/tx/${payload.lastTrade.txHash}`,
    });
  }

  if (payload.walletExplorerUrl) {
    actions.push({
      text: "查看钱包",
      type: actions.length === 0 ? "primary" : "default",
      url: payload.walletExplorerUrl,
    });
  }

  return actions;
}
