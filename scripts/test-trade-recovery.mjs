import assert from "node:assert/strict";
import { ethers } from "ethers";
import { recoverTradeAmounts } from "./lib/trade-recovery.mjs";

const walletAddress = "0xE4d5bE169574FC9E18Edaa813790f079e1630B6d";
const routerAddress = "0x1111111111111111111111111111111111111111";
const usdcTokenAddress = "0x833589fCD6EDB6E08f4c7C32D4f71b54bdA02913";
const aidogTokenAddress = "0x2222222222222222222222222222222222222222";
const transferInterface = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

testReceiptRecovery();
testSnapshotFallback();
testConfiguredFallback();

console.log("Trade recovery test passed.");

function testReceiptRecovery() {
  const amounts = recoverTradeAmounts({
    receipt: {
      logs: [
        makeTransferLog(usdcTokenAddress, walletAddress, routerAddress, 2_000_000n),
        makeTransferLog(aidogTokenAddress, routerAddress, walletAddress, 490n * 10n ** 18n),
      ],
    },
    walletAddress,
    spentTokenAddress: usdcTokenAddress,
    receivedTokenAddress: aidogTokenAddress,
    fallbackSpentBaseUnits: "4000000",
    fallbackReceivedBaseUnits: "980000000000000000000",
  });

  assert.equal(amounts.spentBaseUnits, 2_000_000n);
  assert.equal(amounts.receivedBaseUnits, 490n * 10n ** 18n);
  assert.equal(amounts.spentSource, "receipt");
  assert.equal(amounts.receivedSource, "receipt");
}

function testSnapshotFallback() {
  const amounts = recoverTradeAmounts({
    receipt: { logs: [] },
    walletAddress,
    spentTokenAddress: usdcTokenAddress,
    receivedTokenAddress: aidogTokenAddress,
    walletSnapshotBefore: {
      usdcBalance: 18_000_000n,
      aidogBalance: 0n,
    },
    walletSnapshotAfter: {
      usdcBalance: 16_000_000n,
      aidogBalance: 490n * 10n ** 18n,
    },
    fallbackSpentBaseUnits: "4000000",
    fallbackReceivedBaseUnits: "980000000000000000000",
  });

  assert.equal(amounts.spentBaseUnits, 2_000_000n);
  assert.equal(amounts.receivedBaseUnits, 490n * 10n ** 18n);
  assert.equal(amounts.spentSource, "snapshot");
  assert.equal(amounts.receivedSource, "snapshot");
}

function testConfiguredFallback() {
  const amounts = recoverTradeAmounts({
    receipt: { logs: [] },
    walletAddress,
    spentTokenAddress: usdcTokenAddress,
    receivedTokenAddress: aidogTokenAddress,
    fallbackSpentBaseUnits: "2000000",
    fallbackReceivedBaseUnits: "490000000000000000000",
  });

  assert.equal(amounts.spentBaseUnits, 2_000_000n);
  assert.equal(amounts.receivedBaseUnits, 490n * 10n ** 18n);
  assert.equal(amounts.spentSource, "fallback");
  assert.equal(amounts.receivedSource, "fallback");
}

function makeTransferLog(tokenAddress, from, to, value) {
  const encoded = transferInterface.encodeEventLog("Transfer", [from, to, value]);

  return {
    address: tokenAddress,
    topics: encoded.topics,
    data: encoded.data,
  };
}
