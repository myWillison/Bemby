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

const PREFIX = "ABC-30-Register_";

describe("extractCodes", () => {
  it("extracts a single code from a line", () => {
    const { codes, usedPartials } = extractCodes(
      "ABC-30-Register_xk3mh*puUZR",
      PREFIX,
    );
    expect(codes).toEqual(["ABC-30-Register_xk3mh*puUZR"]);
    expect(usedPartials).toEqual([]);
  });

  it("extracts multiple codes on separate lines of one message", () => {
    const text = [
      "🎯 somebot已为您生成了 30天 注册码 5 个",
      "删除“*”",
      "ABC-30-Register_xk3mh*puUZR",
      "ABC-30-Register_SljWEmZa*Qd",
      "ABC-30-Register_MEPR*XKiE3I",
    ].join("\n");
    const { codes } = extractCodes(text, PREFIX);
    expect(codes).toEqual([
      "ABC-30-Register_xk3mh*puUZR",
      "ABC-30-Register_SljWEmZa*Qd",
      "ABC-30-Register_MEPR*XKiE3I",
    ]);
  });

  it("treats a masked code as a used-code announcement, not a fresh code", () => {
    const text =
      "🎫 注册码使用 - SomeUser [123456789] 使用了 ABC-30-Register_85D▓▓▓▓▓▓▓▓";
    const { codes, usedPartials } = extractCodes(text, PREFIX);
    expect(codes).toEqual([]);
    expect(usedPartials).toEqual(["ABC-30-Register_85D"]);
  });

  it("ignores a bare prefix with no code after it", () => {
    const { codes } = extractCodes("ABC-30-Register_", PREFIX);
    expect(codes).toEqual([]);
  });

  it("finds a code mid-line and stops at whitespace", () => {
    const { codes } = extractCodes(
      "use ABC-30-Register_abc123 before it expires",
      PREFIX,
    );
    expect(codes).toEqual(["ABC-30-Register_abc123"]);
  });

  it("returns nothing when the prefix is empty or absent", () => {
    expect(extractCodes("any text", "").codes).toEqual([]);
    expect(extractCodes("no codes here", PREFIX).codes).toEqual([]);
  });

  it("wildcard prefix matches any duration", () => {
    const text = [
      "ABC-30-Register_abc123",
      "ABC-7-Register_def456",
      "ABC-365-Register_ghi789",
    ].join("\n");
    const { codes } = extractCodes(text, "ABC-*-Register_");
    expect(codes).toEqual([
      "ABC-30-Register_abc123",
      "ABC-7-Register_def456",
      "ABC-365-Register_ghi789",
    ]);
  });

  it("wildcard prefix still detects masked used-code announcements", () => {
    const { codes, usedPartials } = extractCodes(
      "使用了 ABC-7-Register_85D▓▓▓▓",
      "ABC-*-Register_",
    );
    expect(codes).toEqual([]);
    expect(usedPartials).toEqual(["ABC-7-Register_85D"]);
  });

  it("wildcard prefix does not cross whitespace", () => {
    const { codes } = extractCodes(
      "ABC- broken Register_zzz and ABC-14-Register_ok1",
      "ABC-*-Register_",
    );
    expect(codes).toEqual(["ABC-14-Register_ok1"]);
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
      "快抢 https://sfsffsf.xomsddf?start=ABC-7-Register_85Dxxxxx",
      "ABC-*-Register_",
    );
    expect(codes).toEqual(["ABC-7-Register_85Dxxxxx"]);
  });

  it("stops a URL-embedded code at the next query parameter", () => {
    const { codes } = extractCodes(
      "https://t.me/somebot?start=ABC-30-Register_abc123&lang=zh",
      "ABC-*-Register_",
    );
    expect(codes).toEqual(["ABC-30-Register_abc123"]);
  });
});
