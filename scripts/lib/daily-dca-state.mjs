const PERSISTENT_DAILY_DCA_GUARD_CODES = new Set([
  "INSUFFICIENT_USDC",
  "DAILY_COUNT_LIMIT",
  "DAILY_BUDGET_LIMIT",
  "MAX_AIDOG_BALANCE_REACHED",
]);

export function normalizeDailyDcaState(rawState) {
  return {
    lastExecutedDayKey: String(rawState?.lastExecutedDayKey || ""),
    lastSuccessAtMs: Number(rawState?.lastSuccessAtMs || 0),
    lastSuccessTxHash: String(rawState?.lastSuccessTxHash || ""),
    lastSkippedDayKey: String(rawState?.lastSkippedDayKey || ""),
    lastSkipCode: String(rawState?.lastSkipCode || ""),
  };
}

export function hasHandledDailyDcaForDay(strategyState, tradingDayKey) {
  const normalizedState = normalizeDailyDcaState(strategyState);
  return (
    normalizedState.lastExecutedDayKey === tradingDayKey ||
    normalizedState.lastSkippedDayKey === tradingDayKey
  );
}

export function shouldPersistDailyDcaGuardFailure(errorCode) {
  return PERSISTENT_DAILY_DCA_GUARD_CODES.has(String(errorCode || "").trim().toUpperCase());
}

export function rememberDailyDcaGuardFailure(strategyState, tradingDayKey, errorCode) {
  const normalizedState = normalizeDailyDcaState(strategyState);
  if (!shouldPersistDailyDcaGuardFailure(errorCode)) {
    return normalizedState;
  }

  return {
    ...normalizedState,
    lastSkippedDayKey: String(tradingDayKey || ""),
    lastSkipCode: String(errorCode || ""),
  };
}

export function clearDailyDcaSkip(strategyState) {
  const normalizedState = normalizeDailyDcaState(strategyState);
  return {
    ...normalizedState,
    lastSkippedDayKey: "",
    lastSkipCode: "",
  };
}
