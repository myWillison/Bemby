// vi.mock calls are hoisted before imports, preventing the DB from opening
vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  },
}));

import { describe, it, expect, vi } from "vitest";
import { extractCodes } from "../jobs/autoreg";

const PREFIX = "NONAY-30-Register_";

describe("extractCodes", () => {
  it("extracts a single code from a line", () => {
    const { codes, usedPartials } = extractCodes(
      "NONAY-30-Register_xk3mh*puUZR",
      PREFIX,
    );
    expect(codes).toEqual(["NONAY-30-Register_xk3mh*puUZR"]);
    expect(usedPartials).toEqual([]);
  });

  it("extracts multiple codes on separate lines of one message", () => {
    const text = [
      "🎯 fyemby_bot已为您生成了 30天 注册码 5 个",
      "删除“*”",
      "NONAY-30-Register_xk3mh*puUZR",
      "NONAY-30-Register_SljWEmZa*Qd",
      "NONAY-30-Register_MEPR*XKiE3I",
    ].join("\n");
    const { codes } = extractCodes(text, PREFIX);
    expect(codes).toEqual([
      "NONAY-30-Register_xk3mh*puUZR",
      "NONAY-30-Register_SljWEmZa*Qd",
      "NONAY-30-Register_MEPR*XKiE3I",
    ]);
  });

  it("treats a masked code as a used-code announcement, not a fresh code", () => {
    const text =
      "🎫 注册码使用 - Surryliu [1093371556] 使用了 NONAY-30-Register_85D▓▓▓▓▓▓▓▓";
    const { codes, usedPartials } = extractCodes(text, PREFIX);
    expect(codes).toEqual([]);
    expect(usedPartials).toEqual(["NONAY-30-Register_85D"]);
  });

  it("ignores a bare prefix with no code after it", () => {
    const { codes } = extractCodes("NONAY-30-Register_", PREFIX);
    expect(codes).toEqual([]);
  });

  it("finds a code mid-line and stops at whitespace", () => {
    const { codes } = extractCodes(
      "use NONAY-30-Register_abc123 before it expires",
      PREFIX,
    );
    expect(codes).toEqual(["NONAY-30-Register_abc123"]);
  });

  it("returns nothing when the prefix is empty or absent", () => {
    expect(extractCodes("any text", "").codes).toEqual([]);
    expect(extractCodes("no codes here", PREFIX).codes).toEqual([]);
  });

  it("wildcard prefix matches any duration", () => {
    const text = [
      "NONAY-30-Register_abc123",
      "NONAY-7-Register_def456",
      "NONAY-365-Register_ghi789",
    ].join("\n");
    const { codes } = extractCodes(text, "NONAY-*-Register_");
    expect(codes).toEqual([
      "NONAY-30-Register_abc123",
      "NONAY-7-Register_def456",
      "NONAY-365-Register_ghi789",
    ]);
  });

  it("wildcard prefix still detects masked used-code announcements", () => {
    const { codes, usedPartials } = extractCodes(
      "使用了 NONAY-7-Register_85D▓▓▓▓",
      "NONAY-*-Register_",
    );
    expect(codes).toEqual([]);
    expect(usedPartials).toEqual(["NONAY-7-Register_85D"]);
  });

  it("wildcard prefix does not cross whitespace", () => {
    const { codes } = extractCodes(
      "NONAY- broken Register_zzz and NONAY-14-Register_ok1",
      "NONAY-*-Register_",
    );
    expect(codes).toEqual(["NONAY-14-Register_ok1"]);
  });

  it("regex special characters in the prefix are treated literally", () => {
    const { codes } = extractCodes(
      "CODE(A)+B_xyz789",
      "CODE(A)+B_",
    );
    expect(codes).toEqual(["CODE(A)+B_xyz789"]);
  });

  it("extracts a code embedded in a ?start= deep link", () => {
    const { codes } = extractCodes(
      "快抢 https://sfsffsf.xomsddf?start=NONAY-7-Register_85Dxxxxx",
      "NONAY-*-Register_",
    );
    expect(codes).toEqual(["NONAY-7-Register_85Dxxxxx"]);
  });

  it("stops a URL-embedded code at the next query parameter", () => {
    const { codes } = extractCodes(
      "https://t.me/somebot?start=NONAY-30-Register_abc123&lang=zh",
      "NONAY-*-Register_",
    );
    expect(codes).toEqual(["NONAY-30-Register_abc123"]);
  });
});
