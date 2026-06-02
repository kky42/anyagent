const FIELD_RANGES = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 }
];

function assertInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  return parsed;
}

function parseNumber(token, range, fieldName) {
  const value = assertInteger(token, fieldName);
  if (value < range.min || value > range.max) {
    throw new Error(
      `${fieldName} must be between ${range.min} and ${range.max}`
    );
  }
  return value;
}

function expandRange(start, end, step, range, fieldName) {
  if (step <= 0) {
    throw new Error(`${fieldName} step must be greater than 0`);
  }
  if (end < start) {
    throw new Error(`${fieldName} range end must be >= start`);
  }

  const values = [];
  for (let value = start; value <= end; value += step) {
    if (value < range.min || value > range.max) {
      throw new Error(
        `${fieldName} must be between ${range.min} and ${range.max}`
      );
    }
    values.push(value);
  }
  return values;
}

function parseFieldToken(token, range, fieldName) {
  const normalized = String(token ?? "").trim();
  if (!normalized) {
    throw new Error(`${fieldName} field is empty`);
  }

  const [base, stepToken] = normalized.split("/");
  if (normalized.split("/").length > 2) {
    throw new Error(`${fieldName} field has too many "/" separators`);
  }
  const step = stepToken === undefined ? 1 : assertInteger(stepToken, fieldName);

  if (base === "*") {
    return expandRange(range.min, range.max, step, range, fieldName);
  }

  if (base.includes("-")) {
    const [startToken, endToken] = base.split("-");
    if (base.split("-").length !== 2) {
      throw new Error(`${fieldName} field has an invalid range`);
    }
    const start = parseNumber(startToken, range, fieldName);
    const end = parseNumber(endToken, range, fieldName);
    return expandRange(start, end, step, range, fieldName);
  }

  if (stepToken !== undefined) {
    const start = parseNumber(base, range, fieldName);
    return expandRange(start, range.max, step, range, fieldName);
  }

  return [parseNumber(base, range, fieldName)];
}

function parseField(fieldText, range, fieldName) {
  const values = new Set();
  const tokens = String(fieldText ?? "").split(",");
  if (tokens.length === 0) {
    throw new Error(`${fieldName} field is empty`);
  }
  for (const token of tokens) {
    for (const value of parseFieldToken(token, range, fieldName)) {
      values.add(value);
    }
  }
  return [...values].sort((left, right) => left - right);
}

export function parseCronExpression(expression) {
  const trimmed = String(expression ?? "").trim();
  const fields = trimmed.split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    throw new Error("Cron must use exactly 5 fields: minute hour day-of-month month day-of-week");
  }

  const names = ["minute", "hour", "day-of-month", "month", "day-of-week"];
  const parsedFields = fields.map((field, index) =>
    parseField(field, FIELD_RANGES[index], names[index])
  );

  return {
    expression: fields.join(" "),
    minutes: new Set(parsedFields[0]),
    hours: new Set(parsedFields[1]),
    daysOfMonth: new Set(parsedFields[2]),
    months: new Set(parsedFields[3]),
    daysOfWeek: new Set(parsedFields[4])
  };
}

function matchesCron(cron, date) {
  return (
    cron.minutes.has(date.getMinutes()) &&
    cron.hours.has(date.getHours()) &&
    cron.daysOfMonth.has(date.getDate()) &&
    cron.months.has(date.getMonth() + 1) &&
    cron.daysOfWeek.has(date.getDay())
  );
}

function nextMinute(date) {
  const result = new Date(date.getTime());
  result.setSeconds(0, 0);
  result.setMinutes(result.getMinutes() + 1);
  return result;
}

export function nextCronOccurrence(cronOrExpression, now = new Date()) {
  const cron =
    typeof cronOrExpression === "string"
      ? parseCronExpression(cronOrExpression)
      : cronOrExpression;
  const candidate = nextMinute(now);
  const deadline = new Date(candidate.getTime());
  deadline.setFullYear(deadline.getFullYear() + 5);

  while (candidate <= deadline) {
    if (matchesCron(cron, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(`Could not find a future occurrence for cron "${cron.expression}"`);
}

export function delayUntilCronOccurrence(cronOrExpression, now = new Date()) {
  const next = nextCronOccurrence(cronOrExpression, now);
  return {
    next,
    delayMs: Math.max(0, next.getTime() - now.getTime())
  };
}
