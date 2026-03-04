import fs from "node:fs";
import path from "node:path";

export function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function loadJsonFile(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallbackValue;
    }

    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallbackValue;
  }
}

export function saveJsonFile(filePath, value) {
  ensureDirectory(path.dirname(filePath));

  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

export function createLogger({ logFile, tradeLogFile }) {
  ensureDirectory(path.dirname(logFile));
  ensureDirectory(path.dirname(tradeLogFile));

  return {
    info(message, context) {
      writeLine("INFO", message, context);
    },
    warn(message, context) {
      writeLine("WARN", message, context);
    },
    error(message, context) {
      writeLine("ERROR", message, context);
    },
    trade(event, payload) {
      const entry = {
        ts: new Date().toISOString(),
        event,
        payload,
      };

      fs.appendFileSync(tradeLogFile, `${JSON.stringify(entry)}\n`, "utf8");
      writeLine("TRADE", event, payload);
    },
  };

  function writeLine(level, message, context) {
    const ts = new Date().toISOString();
    const suffix = formatContext(context);
    const line = `${ts} [${level}] ${message}${suffix}`;

    if (level === "ERROR") {
      console.error(line);
    } else {
      console.log(line);
    }

    fs.appendFileSync(logFile, `${line}\n`, "utf8");
  }
}

export function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function getTimeZoneParts(timeZone, date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export function getWeekTimeZoneInfo(timeZone, date = new Date()) {
  const parts = getTimeZoneParts(timeZone, date);
  const localUtcDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const weekday = localUtcDate.getUTCDay();
  const isoWeekday = weekday === 0 ? 7 : weekday;

  const weekStartUtcDate = new Date(localUtcDate);
  weekStartUtcDate.setUTCDate(localUtcDate.getUTCDate() - (isoWeekday - 1));

  const weekEndUtcDate = new Date(weekStartUtcDate);
  weekEndUtcDate.setUTCDate(weekStartUtcDate.getUTCDate() + 6);

  return {
    isoWeekday,
    weekKey: formatUtcDayKey(weekStartUtcDate),
    weekStartDayKey: formatUtcDayKey(weekStartUtcDate),
    weekEndDayKey: formatUtcDayKey(weekEndUtcDate),
  };
}

function formatUtcDayKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatContext(context) {
  if (!context || Object.keys(context).length === 0) {
    return "";
  }

  return ` ${JSON.stringify(context)}`;
}
