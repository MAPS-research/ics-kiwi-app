import { describe, expect, it } from "vitest";
import { applyTimeSelection, fallbackTimeRange, initialTimeSelection, parseTimeSelection, rangeQuery, storeSelection } from "./timeRange";

describe("time range selection (§13.0)", () => {
  it("reads ?range= presets and complete custom ranges", () => {
    expect(parseTimeSelection("?range=this_week")).toEqual({ preset: "this_week" });
    expect(parseTimeSelection("?range=custom&from=2026-10-01T00:00:00Z&to=2026-10-16T00:00:00Z")).toEqual({
      preset: "custom", from: "2026-10-01T00:00:00Z", to: "2026-10-16T00:00:00Z",
    });
    expect(parseTimeSelection("?range=custom&from=x")).toBeNull();
    expect(parseTimeSelection("?range=yesterday")).toBeNull();
  });
  it("writes the selection while keeping other parameters", () => {
    expect(applyTimeSelection("?group=students&from=a&to=b", { preset: "last_7_days" })).toBe("?group=students&range=last_7_days");
    expect(applyTimeSelection("", { preset: "custom", from: "a", to: "b" })).toBe("?range=custom&from=a&to=b");
  });
  it("prefers the URL, then sessionStorage, then Since last class", () => {
    expect(initialTimeSelection("")).toEqual({ preset: "since_last_class" });
    storeSelection({ preset: "whole_term" });
    expect(initialTimeSelection("")).toEqual({ preset: "whole_term" });
    expect(initialTimeSelection("?range=this_class")).toEqual({ preset: "this_class" });
  });
  it("builds fallback ranges and query parameters", () => {
    const fallback = fallbackTimeRange({ preset: "this_week" });
    expect(fallback).toMatchObject({ preset: "this_week", from: null, to: null, label: "This week", compareLabel: null });
    expect(rangeQuery(fallback)).toEqual({});
    expect(rangeQuery({ ...fallback, from: "f", to: "t", compareFrom: "cf", compareTo: null })).toEqual({ from: "f", to: "t", compareFrom: "cf" });
    expect(fallbackTimeRange({ preset: "custom", from: "2026-10-01T04:00:00Z", to: "2026-10-15T04:00:00Z" }).label).toMatch(/^\d\d\/\d\d – \d\d\/\d\d$/);
  });
});
