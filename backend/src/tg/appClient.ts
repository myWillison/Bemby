import { db } from "../db/database";
import type { TgAppClient } from "../types";
import type { TgDeviceParams } from "../auth/tgAuth";

// Per-account map of the randomly-assigned app client, keyed by account id.
// Kept in the settings table so a random pick stays stable for an account.
const ASSIGNMENTS_KEY = "tg_client_assignments";

function readAppClients(): TgAppClient[] {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("tg_app_clients") as { value: string } | undefined;
    if (!row?.value) return [];
    return JSON.parse(row.value) as TgAppClient[];
  } catch {
    return [];
  }
}

function readAssignments(): Record<string, string> {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(ASSIGNMENTS_KEY) as { value: string } | undefined;
    if (!row?.value) return {};
    return JSON.parse(row.value) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveAssignment(accountId: number, clientId: string): void {
  const map = readAssignments();
  map[String(accountId)] = clientId;
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
  ).run(ASSIGNMENTS_KEY, JSON.stringify(map));
}

function toDeviceParams(c: TgAppClient): TgDeviceParams {
  return {
    deviceModel: c.deviceModel,
    systemVersion: c.systemVersion,
    appVersion: c.appVersion,
    langCode: c.langCode,
    langPack: c.langPack,
    systemLangCode: c.systemLangCode,
  };
}

/**
 * Resolve the Telegram device params for an account.
 * - Explicit appClientId: use that client.
 * - No client + random mode: use a per-account sticky random pick that is
 *   persisted, so the same device is reused for auth, jobs and the live client.
 *   Only re-rolls if the previously assigned client no longer exists.
 * - Otherwise: use the default client.
 */
export function resolveAppClientParams(
  accountId: number,
  appClientId: string | null | undefined,
): TgDeviceParams | undefined {
  try {
    const list = readAppClients();
    if (!list.length) return undefined;

    if (appClientId) {
      const client = list.find((c) => c.id === appClientId);
      return client ? toDeviceParams(client) : undefined;
    }

    const modeRow = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("tg_client_mode") as { value: string } | undefined;

    if (modeRow?.value === "random") {
      const assignedId = readAssignments()[String(accountId)];
      const assigned = assignedId
        ? list.find((c) => c.id === assignedId)
        : undefined;
      if (assigned) return toDeviceParams(assigned);
      // First random pick for this account -- persist it so it stays stable.
      const picked = list[Math.floor(Math.random() * list.length)];
      saveAssignment(accountId, picked.id);
      return toDeviceParams(picked);
    }

    const def = list.find((c) => c.isDefault);
    return def ? toDeviceParams(def) : undefined;
  } catch {
    return undefined;
  }
}
