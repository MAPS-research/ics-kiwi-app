import { describe, expect, it } from "vitest";
import {
  formatCountdown,
  formatDate,
  formatDateTime,
  formatDue,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelative,
  formatShortDate,
  formatWeekdayDate,
  formatWeekdayDateTime,
  fromDateTimeLocal,
  toDateTimeLocal,
} from "./format";

const TZ = "Asia/Shanghai";
// 2026-10-22T01:00:00Z is Thu 10/22 09:00 in Shanghai
const NOW = Date.parse("2026-10-22T01:00:00Z");

describe("numbers", () => {
  it("formats numbers and missing values", () => {
    expect(formatNumber(1234.567)).toBe("1,234.6");
    expect(formatNumber(2.345, 2)).toBe("2.35");
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(undefined)).toBe("—");
    expect(formatNumber(Number.NaN)).toBe("—");
    expect(formatPercent(82.66667, 1)).toBe("82.7%");
    expect(formatPercent(null)).toBe("—");
  });
});

describe("dates in the course time zone", () => {
  it("formats date parts in the given zone", () => {
    expect(formatShortDate("2026-10-20T02:00:00Z", TZ)).toBe("10/20");
    expect(formatWeekdayDate("2026-10-20T02:00:00Z", TZ)).toBe("Tue 10/20");
    expect(formatWeekdayDateTime("2026-10-23T15:59:00Z", TZ)).toBe("Fri 10/23 23:59");
    expect(formatWeekdayDate("2026-10-19T17:00:00Z", "America/New_York")).toBe("Mon 10/19");
    expect(formatDate("2026-10-22T01:00:00Z", TZ)).toBe("Oct 22, 2026");
    expect(formatDateTime("2026-10-22T01:00:00Z", { timeZone: TZ })).toBe("Oct 22, 2026, 9:00 AM");
  });
  it("handles missing and invalid dates", () => {
    expect(formatDateTime(null)).toBe("No activity");
    expect(formatDateTime("nope", { empty: "Never" })).toBe("Never");
    expect(formatShortDate(undefined)).toBe("—");
    expect(formatDue(null, NOW)).toBe("No due date");
  });
  it("formats relative times", () => {
    expect(formatRelative("2026-10-22T00:59:40Z", NOW)).toBe("just now");
    expect(formatRelative("2026-10-22T00:55:00Z", NOW)).toBe("5 min ago");
    expect(formatRelative("2026-10-21T22:00:00Z", NOW)).toBe("3 h ago");
    expect(formatRelative("2026-10-21T01:00:00Z", NOW)).toBe("1 day ago");
    expect(formatRelative("2026-10-19T01:00:00Z", NOW)).toBe("3 days ago");
    expect(formatRelative("2026-10-22T01:10:00Z", NOW)).toBe("in 10 min");
  });
  it("formats due dates before and after the deadline", () => {
    expect(formatDue("2026-10-23T15:59:00Z", NOW, TZ)).toBe("Due Fri 10/23 23:59");
    expect(formatDue("2026-10-20T15:59:00Z", NOW, TZ)).toBe("Past due · Tue 10/20 23:59");
  });
});

describe("durations", () => {
  it("formats countdowns without going negative", () => {
    expect(formatCountdown(245_000)).toBe("4:05");
    expect(formatCountdown(3_723_000)).toBe("1:02:03");
    expect(formatCountdown(-5)).toBe("0:00");
    expect(formatCountdown(500)).toBe("0:01");
  });
  it("formats active durations", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(300)).toBe("5 min");
    expect(formatDuration(3900)).toBe("1 h 05 min");
    expect(formatDuration(null)).toBe("—");
  });
  it("round-trips datetime-local values", () => {
    const iso = "2026-10-24T15:59:00.000Z";
    expect(fromDateTimeLocal(toDateTimeLocal(iso))).toBe(iso);
    expect(toDateTimeLocal(null)).toBe("");
    expect(fromDateTimeLocal("")).toBeNull();
  });
});
