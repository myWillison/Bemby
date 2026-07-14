// The same model id can exist under multiple suppliers (e.g. two accounts of
// the same provider). Credential resolution must prefer a supplier with a key,
// and fallback must try the other supplier's copy rather than skipping it.

let testDb!: InstanceType<typeof Database>;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
}));

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { callAI, recognizeCaptchaWithAI } from "../jobs/checkin";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_suppliers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    base_url   TEXT    NOT NULL,
    api_key    TEXT    NOT NULL DEFAULT '',
    timeout_ms INTEGER NOT NULL DEFAULT 25000
  );
  CREATE TABLE IF NOT EXISTS ai_models (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES ai_suppliers(id) ON DELETE CASCADE,
    model_id    TEXT    NOT NULL,
    label       TEXT
  );
`;

const MODEL = "some/vision-model";
const IMG = "data:image/png;base64,abc";

function insertSupplier(name: string, apiKey: string, modelIds: string[]): number {
  const { lastInsertRowid } = testDb
    .prepare("INSERT INTO ai_suppliers (name, base_url, api_key) VALUES (?, ?, ?)")
    .run(name, `https://api.${name.replace(/\s+/g, "")}.test/v1`, apiKey);
  const supplierId = Number(lastInsertRowid);
  for (const m of modelIds) {
    testDb.prepare("INSERT INTO ai_models (supplier_id, model_id) VALUES (?, ?)").run(supplierId, m);
  }
  return supplierId;
}

function setSetting(key: string, value: string) {
  testDb
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

function aiResponse(text: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
}

const fetchMock = vi.fn<typeof fetch>();

function authKeyOfCall(call: number): string | undefined {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string>)?.Authorization?.replace("Bearer ", "");
}

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.exec(SCHEMA);
  vi.stubGlobal("fetch", fetchMock);
});

beforeEach(() => {
  fetchMock.mockReset();
  testDb.exec("DELETE FROM ai_models; DELETE FROM ai_suppliers; DELETE FROM settings;");
  setSetting("ai_model", MODEL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", fetchMock);
});

describe("credential resolution with duplicate model ids", () => {
  it("prefers a supplier with a non-empty key over an earlier keyless one", async () => {
    insertSupplier("vercel", "", [MODEL]);
    insertSupplier("vercel 2", "key-2", [MODEL]);
    fetchMock.mockResolvedValueOnce(aiResponse("ok"));

    await callAI([IMG], "prompt");

    expect(authKeyOfCall(0)).toBe("key-2");
  });
});

describe("fallback across suppliers sharing a model id", () => {
  it("tries the second supplier's copy of the same model when the first fails", async () => {
    insertSupplier("vercel", "key-1", [MODEL]);
    insertSupplier("vercel 2", "key-2", [MODEL]);
    fetchMock
      .mockResolvedValueOnce(new Response("quota exceeded", { status: 429 }))
      .mockResolvedValueOnce(aiResponse("ABCD"));

    const result = await recognizeCaptchaWithAI([IMG]);

    expect(result.text).toBe("ABCD");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authKeyOfCall(0)).toBe("key-1");
    expect(authKeyOfCall(1)).toBe("key-2");
  });

  it("does not retry identical credentials twice", async () => {
    insertSupplier("vercel", "key-1", [MODEL]);
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    await expect(recognizeCaptchaWithAI([IMG])).rejects.toThrow(/AI API error 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips other suppliers when fallback is disabled", async () => {
    insertSupplier("vercel", "key-1", [MODEL]);
    insertSupplier("vercel 2", "key-2", [MODEL]);
    setSetting("ai_fallback_enabled", "false");
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    await expect(recognizeCaptchaWithAI([IMG])).rejects.toThrow(/AI API error 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
