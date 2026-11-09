import { afterEach, describe, expect, it, vi } from "vitest";
import { csvBlob, csvCell, downloadBlob, toCsv } from "./csv";
import { WEBR_PACKAGE_ALLOWLIST, isAllowedWebrPackage } from "./webrPackages";

/*
 * Coverage for the teaching CSV helpers' browser download path (`downloadBlob`, `csvBlob`) and the webR package
 * allowlist check. Node has no DOM, so `document` and the object-URL functions are stubbed per test.
 */

interface FakeLink { href: string; download: string; rel: string; clicked: number; removed: number; click: () => void; remove: () => void }

function stubDom(onClick: () => void = () => undefined) {
  const link: FakeLink = {
    href: "", download: "", rel: "", clicked: 0, removed: 0,
    click() {
      link.clicked += 1;
      onClick();
    },
    remove() {
      link.removed += 1;
    },
  };
  const appended: unknown[] = [];
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      expect(tag).toBe("a");
      return link;
    },
    body: { appendChild: (node: unknown) => appended.push(node) },
  });
  const created = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost:3000/abc");
  const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  return { link, appended, created, revoked };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("downloadBlob", () => {
  it("clicks a temporary link and revokes the object URL on the next tick", () => {
    vi.useFakeTimers();
    const { link, appended, created, revoked } = stubDom();
    const blob = csvBlob("a,b");
    downloadBlob(blob, "grades.csv");
    expect(created).toHaveBeenCalledWith(blob);
    expect(link).toMatchObject({ href: "blob:http://localhost:3000/abc", download: "grades.csv", rel: "noopener", clicked: 1, removed: 1 });
    expect(appended).toEqual([link]);
    expect(revoked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(revoked).toHaveBeenCalledWith("blob:http://localhost:3000/abc");
  });

  it("still revokes the URL when the click fails", () => {
    vi.useFakeTimers();
    const { revoked } = stubDom(() => {
      throw new Error("blocked by the browser");
    });
    expect(() => downloadBlob(csvBlob(""), "x.csv")).toThrow("blocked by the browser");
    vi.advanceTimersByTime(0);
    expect(revoked).toHaveBeenCalledTimes(1);
  });

  it("refuses outside a browser", () => {
    vi.stubGlobal("document", undefined);
    expect(() => downloadBlob(csvBlob(""), "x.csv")).toThrow("Downloads are only available in a browser.");
  });

  it("refuses when object URLs are unsupported", () => {
    stubDom();
    vi.spyOn(URL, "createObjectURL").mockRestore();
    const original = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    Object.defineProperty(URL, "createObjectURL", { value: undefined, configurable: true, writable: true });
    try {
      expect(() => downloadBlob(csvBlob(""), "x.csv")).toThrow("Downloads are only available in a browser.");
    } finally {
      if (original) Object.defineProperty(URL, "createObjectURL", original);
    }
  });
});

describe("csvBlob", () => {
  it("is UTF-8 CSV whose bytes start with the BOM", async () => {
    const text = toCsv([["Student", "Note"], ["Ada", "=1+1"]]);
    const blob = csvBlob(text);
    expect(blob.type).toBe("text/csv;charset=utf-8");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]); // Blob.text() strips it; spreadsheets read it
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)).toBe(text);
  });
  it("blank cells for non-finite numbers and stringified objects", () => {
    expect(csvCell(Number.POSITIVE_INFINITY)).toBe('""');
    expect(csvCell(true)).toBe('"true"');
    expect(csvCell("1e3", { numeric: true })).toBe('"1e3"');
    expect(csvCell(".5", { numeric: true })).toBe('".5"');
    expect(toCsv([])).toBe("﻿");
  });
});

describe("webR package allowlist (§12.3)", () => {
  it("accepts allowlisted packages exactly, ignoring surrounding spaces", () => {
    expect(isAllowedWebrPackage("dplyr")).toBe(true);
    expect(isAllowedWebrPackage("  quanteda.textstats ")).toBe(true);
    expect(isAllowedWebrPackage("Dplyr")).toBe(false);
  });
  it("excludes the packages webR 0.6.0 cannot install", () => {
    for (const name of ["duke", "ldatuning", "rsvg"]) {
      expect(isAllowedWebrPackage(name)).toBe(false);
      expect(WEBR_PACKAGE_ALLOWLIST).not.toContain(name);
    }
  });
  it("has no duplicates", () => {
    expect(new Set(WEBR_PACKAGE_ALLOWLIST).size).toBe(WEBR_PACKAGE_ALLOWLIST.length);
  });
});
