import assert from "node:assert/strict";

import {
  clearDailyDcaSkip,
  hasHandledDailyDcaForDay,
  normalizeDailyDcaState,
  rememberDailyDcaGuardFailure,
  shouldPersistDailyDcaGuardFailure,
} from "./lib/daily-dca-state.mjs";

testPersistentGuardFailureIsRememberedForTheDay();
testNonPersistentFailureDoesNotSuppressTheDay();
testClearDailyDcaSkipResetsGuardState();

console.log("Daily DCA state test passed.");

function testPersistentGuardFailureIsRememberedForTheDay() {
  const nextState = rememberDailyDcaGuardFailure(
    {
      lastExecutedDayKey: "",
      lastSuccessAtMs: 0,
      lastSuccessTxHash: "",
    },
    "2026-04-02",
    "INSUFFICIENT_USDC",
  );

  assert.equal(nextState.lastSkippedDayKey, "2026-04-02");
  assert.equal(nextState.lastSkipCode, "INSUFFICIENT_USDC");
  assert.equal(hasHandledDailyDcaForDay(nextState, "2026-04-02"), true);
  assert.equal(shouldPersistDailyDcaGuardFailure("INSUFFICIENT_USDC"), true);
}

function testNonPersistentFailureDoesNotSuppressTheDay() {
  const nextState = rememberDailyDcaGuardFailure(
    normalizeDailyDcaState({}),
    "2026-04-02",
    "LOW_GAS_BALANCE",
  );

  assert.equal(nextState.lastSkippedDayKey, "");
  assert.equal(nextState.lastSkipCode, "");
  assert.equal(hasHandledDailyDcaForDay(nextState, "2026-04-02"), false);
  assert.equal(shouldPersistDailyDcaGuardFailure("LOW_GAS_BALANCE"), false);
}

function testClearDailyDcaSkipResetsGuardState() {
  const nextState = clearDailyDcaSkip({
    lastExecutedDayKey: "2026-04-01",
    lastSuccessAtMs: 1,
    lastSuccessTxHash: "0x123",
    lastSkippedDayKey: "2026-04-02",
    lastSkipCode: "INSUFFICIENT_USDC",
  });

  assert.equal(nextState.lastExecutedDayKey, "2026-04-01");
  assert.equal(nextState.lastSkippedDayKey, "");
  assert.equal(nextState.lastSkipCode, "");
}
