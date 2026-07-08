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
import { extractCodes, containsAny } from "../jobs/autoreg";

const PREFIX = "ABC-30-Register_";

describe("extractCodes", () => {
  it("extracts a single code from a line, stripping the * decoy", () => {
    const { codes, usedPartials } = extractCodes(
      "ABC-30-Register_xk3mh*puUZR",
      PREFIX,
    );
    expect(codes).toEqual(["ABC-30-Register_xk3mhpuUZR"]);
    expect(usedPartials).toEqual([]);
  });

  it("extracts multiple codes on separate lines, stripping decoys", () => {
    const text = [
      "🎯 somebot已为您生成了 30天 注册码 5 个",
      "删除“*”",
      "ABC-30-Register_xk3mh*puUZR",
      "ABC-30-Register_SljWEmZa*Qd",
      "ABC-30-Register_MEPR*XKiE3I",
    ].join("\n");
    const { codes } = extractCodes(text, PREFIX);
    expect(codes).toEqual([
      "ABC-30-Register_xk3mhpuUZR",
      "ABC-30-Register_SljWEmZaQd",
      "ABC-30-Register_MEPRXKiE3I",
    ]);
  });

  it("strips a ~ decoy without truncating the code", () => {
    const text = [
      "删除符号“~”",
      "ABC-30-Register_C~3vLEpVAYh",
      "ABC-30-Register_H~a4uGmPetN",
    ].join("\n");
    const { codes, usedPartials } = extractCodes(text, PREFIX);
    expect(codes).toEqual([
      "ABC-30-Register_C3vLEpVAYh",
      "ABC-30-Register_Ha4uGmPetN",
    ]);
    expect(usedPartials).toEqual([]);
  });

  it("discards a short fragment quoted in chat", () => {
    const { codes, usedPartials } = extractCodes(
      "我复制了第一个码是这样子的ABC-30-Register_C",
      PREFIX,
    );
    expect(codes).toEqual([]);
    expect(usedPartials).toEqual([]);
  });

  it("treats a masked code as a used-code announcement, not a fresh code", () => {
    const text =
      "🎫 注册码使用 - SomeUser [123456789] 使用了 ABC-30-Register_85D▓▓▓▓▓▓▓▓";
    const { codes, usedPartials } = extractCodes(text, PREFIX);
    expect(codes).toEqual([]);
    expect(usedPartials).toEqual(["ABC-30-Register_85D"]);
  });

  it.each([
    ["black square", "使用了 ABC-30-Register_C⬛⬛⬛"],
    ["emoji", "使用了 ABC-30-Register_C🔒🔒🔒"],
    ["middle dots", "使用了 ABC-30-Register_C···"],
    ["ellipsis", "使用了 ABC-30-Register_C…"],
    ["fullwidth asterisk", "使用了 ABC-30-Register_C＊＊＊"],
    ["dingbat", "使用了 ABC-30-Register_C✳✳✳"],
  ])("treats a %s-masked code as used, not fresh", (_label, text) => {
    const { codes, usedPartials } = extractCodes(text, PREFIX);
    expect(codes).toEqual([]);
    expect(usedPartials).toEqual(["ABC-30-Register_C"]);
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
      "ABC- broken Register_zzz and ABC-14-Register_ok1x",
      "ABC-*-Register_",
    );
    expect(codes).toEqual(["ABC-14-Register_ok1x"]);
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

describe("containsAny", () => {
  it("matches a single keyword", () => {
    expect(containsAny("注册码已被使用", "已被使用")).toBe(true);
    expect(containsAny("注册成功", "已被使用")).toBe(false);
  });

  it("matches any of multiple |-separated keywords", () => {
    const keywords = "已被使用|错误";
    expect(containsAny("注册码已被使用", keywords)).toBe(true);
    expect(containsAny("你输入了一个错误de注册码", keywords)).toBe(true);
    expect(containsAny("注册成功", keywords)).toBe(false);
  });

  it("ignores blank keywords and surrounding whitespace", () => {
    expect(containsAny("some text", "| |")).toBe(false);
    expect(containsAny("bad code", " bad |")).toBe(true);
  });

  it("returns false when no keywords are configured", () => {
    expect(containsAny("anything", undefined)).toBe(false);
    expect(containsAny("anything", "")).toBe(false);
  });
});
