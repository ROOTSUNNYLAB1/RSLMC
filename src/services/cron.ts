/**
 * Minimal 5-field cron parser: minute hour day-of-month month day-of-week.
 * Supports *, lists, ranges and step values. Deliberately small and predictable.
 */
interface CronField { values: Set<number>; wildcard: boolean }

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function parseField(input: string, index: number): CronField {
  const [min, max] = RANGES[index]!;
  const values = new Set<number>();
  let wildcard = false;
  for (const part of input.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) throw new Error(`Empty cron field segment in "${input}"`);
    if (trimmed === "*") {
      wildcard = true;
      for (let value = min; value <= max; value++) values.add(value);
      continue;
    }
    const stepMatch = /^(.*)\/(\d+)$/.exec(trimmed);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (step <= 0) throw new Error(`Invalid cron step in "${trimmed}"`);
    const base = stepMatch ? stepMatch[1]! : trimmed;
    let start = min;
    let end = max;
    if (base !== "*") {
      const rangeMatch = /^(\d+)-(\d+)$/.exec(base);
      if (rangeMatch) {
        start = Number(rangeMatch[1]);
        end = Number(rangeMatch[2]);
      } else {
        start = Number(base);
        end = base === "" ? max : start;
        if (!Number.isFinite(start)) throw new Error(`Invalid cron value "${trimmed}"`);
      }
    }
    if (start < min || end > max || start > end) throw new Error(`Cron value out of range in "${trimmed}"`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { values, wildcard };
}

export interface CronSchedule {
  expression: string;
  minutes: CronField;
  hours: CronField;
  days: CronField;
  months: CronField;
  weekdays: CronField;
}

export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron expressions must have exactly 5 fields (minute hour day month weekday)");
  return {
    expression: expression.trim(),
    minutes: parseField(parts[0]!, 0),
    hours: parseField(parts[1]!, 1),
    days: parseField(parts[2]!, 2),
    months: parseField(parts[3]!, 3),
    weekdays: parseField(parts[4]!, 4),
  };
}

/** Finds the next matching time strictly after `from`, scanning up to one year ahead. */
export function nextCronRun(schedule: CronSchedule, from = new Date()): Date | null {
  const candidate = new Date(from.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  const limit = new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (candidate < limit) {
    if (!schedule.months.values.has(candidate.getUTCMonth() + 1)) {
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const dayMatches = schedule.days.values.has(candidate.getUTCDate());
    const weekdayMatches = schedule.weekdays.values.has(candidate.getUTCDay());
    const dayOk = schedule.days.wildcard || schedule.weekdays.wildcard ? dayMatches && weekdayMatches : dayMatches || weekdayMatches;
    if (!dayOk) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!schedule.hours.values.has(candidate.getUTCHours())) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!schedule.minutes.values.has(candidate.getUTCMinutes())) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return candidate;
  }
  return null;
}

export function describeCron(expression: string): string {
  const trimmed = expression.trim();
  const presets: Record<string, string> = {
    "0 * * * *": "Every hour",
    "0 0 * * *": "Every day at 00:00 UTC",
    "0 4 * * *": "Every day at 04:00 UTC",
    "0 3 * * 0": "Every Sunday at 03:00 UTC",
    "*/30 * * * *": "Every 30 minutes",
    "*/15 * * * *": "Every 15 minutes",
    "0 0 1 * *": "First day of each month at 00:00 UTC",
  };
  return presets[trimmed] ?? `Custom schedule (${trimmed})`;
}

export function validateCron(expression: string): { ok: boolean; message: string } {
  try {
    const parsed = parseCron(expression);
    const next = nextCronRun(parsed);
    if (!next) return { ok: false, message: "This expression never runs" };
    return { ok: true, message: `Next run: ${next.toISOString()}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Invalid expression" };
  }
}
