import { ethers } from "ethers";

const transferInterface = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export function recoverTradeAmounts({
  receipt,
  walletAddress,
  spentTokenAddress,
  receivedTokenAddress,
  fallbackSpentBaseUnits = "0",
  fallbackReceivedBaseUnits = "0",
  walletSnapshotBefore = null,
  walletSnapshotAfter = null,
}) {
  const receiptAmounts = extractTokenTransfersFromReceipt({
    receipt,
    walletAddress,
    spentTokenAddress,
    receivedTokenAddress,
  });
  const snapshotAmounts = extractTradeAmountsFromSnapshots({
    walletSnapshotBefore,
    walletSnapshotAfter,
  });
  const spent = pickAmount([
    ["receipt", receiptAmounts.spentBaseUnits],
    ["snapshot", snapshotAmounts.spentBaseUnits],
    ["fallback", fallbackSpentBaseUnits],
  ]);
  const received = pickAmount([
    ["receipt", receiptAmounts.receivedBaseUnits],
    ["snapshot", snapshotAmounts.receivedBaseUnits],
    ["fallback", fallbackReceivedBaseUnits],
  ]);

  return {
    spentBaseUnits: spent.amount,
    receivedBaseUnits: received.amount,
    spentSource: spent.source,
    receivedSource: received.source,
  };
}

export function mergeTradeSnapshotWithRecoveredAmounts({
  walletSnapshotBefore,
  walletSnapshotAfter,
  spentBaseUnits,
  receivedBaseUnits,
}) {
  if (!walletSnapshotBefore) {
    return walletSnapshotAfter;
  }

  if (!walletSnapshotAfter) {
    return {
      baseEthBalance: toBigInt(walletSnapshotBefore.baseEthBalance),
      usdcBalance: deriveUsdcBalanceAfter(walletSnapshotBefore.usdcBalance, spentBaseUnits),
      aidogBalance: deriveAidogBalanceAfter(walletSnapshotBefore.aidogBalance, receivedBaseUnits),
    };
  }

  const beforeUsdc = toBigInt(walletSnapshotBefore.usdcBalance);
  const afterUsdc = toBigInt(walletSnapshotAfter.usdcBalance);
  const beforeAidog = toBigInt(walletSnapshotBefore.aidogBalance);
  const afterAidog = toBigInt(walletSnapshotAfter.aidogBalance);
  const spent = toBigInt(spentBaseUnits);
  const received = toBigInt(receivedBaseUnits);

  return {
    baseEthBalance: toBigInt(walletSnapshotAfter.baseEthBalance),
    usdcBalance: shouldUseDerivedUsdcBalance(beforeUsdc, afterUsdc, spent)
      ? deriveUsdcBalanceAfter(beforeUsdc, spent)
      : afterUsdc,
    aidogBalance: shouldUseDerivedAidogBalance(beforeAidog, afterAidog, received)
      ? deriveAidogBalanceAfter(beforeAidog, received)
      : afterAidog,
  };
}

export function extractTokenTransfersFromReceipt({
  receipt,
  walletAddress,
  spentTokenAddress,
  receivedTokenAddress,
}) {
  const normalizedWallet = String(walletAddress || "").toLowerCase();
  const normalizedSpentToken = String(spentTokenAddress || "").toLowerCase();
  const normalizedReceivedToken = String(receivedTokenAddress || "").toLowerCase();

  let spentBaseUnits = 0n;
  let receivedBaseUnits = 0n;

  for (const log of Array.isArray(receipt?.logs) ? receipt.logs : []) {
    const tokenAddress = String(log?.address || "").toLowerCase();
    if (tokenAddress !== normalizedSpentToken && tokenAddress !== normalizedReceivedToken) {
      continue;
    }

    let parsedLog;
    try {
      parsedLog = transferInterface.parseLog(log);
    } catch {
      continue;
    }

    if (!parsedLog || parsedLog.name !== "Transfer") {
      continue;
    }

    const from = String(parsedLog.args.from || "").toLowerCase();
    const to = String(parsedLog.args.to || "").toLowerCase();
    const value = toBigInt(parsedLog.args.value);

    if (tokenAddress === normalizedSpentToken && from === normalizedWallet) {
      spentBaseUnits += value;
    }

    if (tokenAddress === normalizedReceivedToken && to === normalizedWallet) {
      receivedBaseUnits += value;
    }
  }

  return {
    spentBaseUnits,
    receivedBaseUnits,
  };
}

export function extractTradeAmountsFromSnapshots({
  walletSnapshotBefore,
  walletSnapshotAfter,
}) {
  if (!walletSnapshotBefore || !walletSnapshotAfter) {
    return {
      spentBaseUnits: 0n,
      receivedBaseUnits: 0n,
    };
  }

  const beforeUsdc = toBigInt(walletSnapshotBefore.usdcBalance);
  const afterUsdc = toBigInt(walletSnapshotAfter.usdcBalance);
  const beforeAidog = toBigInt(walletSnapshotBefore.aidogBalance);
  const afterAidog = toBigInt(walletSnapshotAfter.aidogBalance);

  return {
    spentBaseUnits: beforeUsdc > afterUsdc ? beforeUsdc - afterUsdc : 0n,
    receivedBaseUnits: afterAidog > beforeAidog ? afterAidog - beforeAidog : 0n,
  };
}

function pickAmount(candidates) {
  for (const [source, rawAmount] of candidates) {
    const amount = toBigInt(rawAmount);
    if (amount > 0n) {
      return { amount, source };
    }
  }

  return {
    amount: 0n,
    source: "zero",
  };
}

function shouldUseDerivedUsdcBalance(beforeUsdc, afterUsdc, spentBaseUnits) {
  const spent = toBigInt(spentBaseUnits);
  if (spent <= 0n) {
    return false;
  }

  const observedSpent = beforeUsdc > afterUsdc ? beforeUsdc - afterUsdc : 0n;
  return observedSpent === 0n || observedSpent < spent;
}

function shouldUseDerivedAidogBalance(beforeAidog, afterAidog, receivedBaseUnits) {
  const received = toBigInt(receivedBaseUnits);
  if (received <= 0n) {
    return false;
  }

  const observedReceived = afterAidog > beforeAidog ? afterAidog - beforeAidog : 0n;
  return observedReceived === 0n || observedReceived < received;
}

function deriveUsdcBalanceAfter(beforeUsdc, spentBaseUnits) {
  const before = toBigInt(beforeUsdc);
  const spent = toBigInt(spentBaseUnits);
  return before > spent ? before - spent : 0n;
}

function deriveAidogBalanceAfter(beforeAidog, receivedBaseUnits) {
  return toBigInt(beforeAidog) + toBigInt(receivedBaseUnits);
}

function toBigInt(value) {
  if (typeof value === "bigint") {
    return value;
  }

  if (value == null || value === "") {
    return 0n;
  }

  return BigInt(value);
}
