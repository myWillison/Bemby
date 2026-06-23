import { Router } from 'express';
import { db } from '../db/database';
import { requestCode, submitCode, submitPassword } from '../auth/tgAuth';
import type { AuthStatus } from '../types';
import { parseTgProxy } from '../jobs/runner';

const router = Router();

type AccountRow = {
  id: number;
  name: string;
  phone_number: string;
  api_id: number;
  api_hash: string;
  session_string: string | null;
  auth_status: AuthStatus;
  proxy_id: string | null;
  created_at: string;
};

function resolveProxyUrl(proxyId: string | null | undefined): string | undefined {
  if (!proxyId) return undefined;
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('proxies') as { value: string } | undefined;
    if (!row?.value) return undefined;
    const list = JSON.parse(row.value) as Array<{ id: string; url: string }>;
    return list.find(p => p.id === proxyId)?.url;
  } catch { return undefined; }
}

function toJson(row: AccountRow) {
  return {
    id: row.id,
    name: row.name,
    phoneNumber: row.phone_number,
    apiId: row.api_id,
    // apiHash intentionally omitted from responses
    authStatus: row.auth_status,
    proxyId: row.proxy_id ?? null,
    createdAt: row.created_at,
  };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM tg_accounts ORDER BY id').all() as AccountRow[];
  res.json(rows.map(toJson));
});

router.post('/', (req, res) => {
  const { name, phoneNumber, apiId, apiHash, proxyId } = req.body as Record<string, string>;
  if (!name || !phoneNumber || !apiId || !apiHash) {
    res.status(400).json({ error: 'name, phoneNumber, apiId, apiHash are required' });
    return;
  }

  const result = db.prepare(
    'INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, proxy_id) VALUES (?, ?, ?, ?, ?)'
  ).run(name, phoneNumber, Number(apiId), apiHash, proxyId || null);

  const row = db.prepare('SELECT * FROM tg_accounts WHERE id = ?').get(result.lastInsertRowid) as AccountRow;
  res.status(201).json(toJson(row));
});

router.put('/:id', (req, res) => {
  const { name, phoneNumber, apiId, apiHash, proxyId } = req.body as Record<string, string | null>;
  const existing = db.prepare('SELECT * FROM tg_accounts WHERE id = ?').get(req.params.id) as AccountRow | undefined;
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

  // proxyId: undefined = not in payload (keep existing), null/'' = clear proxy
  const newProxyId = proxyId !== undefined ? (proxyId || null) : existing.proxy_id;

  db.prepare(
    'UPDATE tg_accounts SET name = ?, phone_number = ?, api_id = ?, api_hash = ?, proxy_id = ? WHERE id = ?'
  ).run(
    name ?? existing.name,
    phoneNumber ?? existing.phone_number,
    Number(apiId ?? existing.api_id),
    apiHash ?? existing.api_hash,
    newProxyId,
    req.params.id,
  );

  const row = db.prepare('SELECT * FROM tg_accounts WHERE id = ?').get(req.params.id) as AccountRow;
  res.json(toJson(row));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM tg_accounts WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

// ── Telegram auth flow ──────────────────────────────────────────────────────

router.post('/:id/auth/request', async (req, res) => {
  const account = db.prepare('SELECT * FROM tg_accounts WHERE id = ?').get(req.params.id) as AccountRow | undefined;
  if (!account) { res.status(404).json({ error: 'Not found' }); return; }

  try {
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    await requestCode(account.id, account.api_id, account.api_hash, account.phone_number, proxy);
    db.prepare("UPDATE tg_accounts SET auth_status = 'pending_code' WHERE id = ?").run(account.id);
    res.json({ message: 'Verification code sent' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/auth/verify', async (req, res) => {
  const account = db.prepare('SELECT * FROM tg_accounts WHERE id = ?').get(req.params.id) as AccountRow | undefined;
  if (!account) { res.status(404).json({ error: 'Not found' }); return; }

  const { code, password } = req.body as { code?: string; password?: string };

  try {
    if (account.auth_status === 'pending_code' && code) {
      const result = await submitCode(account.id, code);
      if (result.needsPassword) {
        db.prepare("UPDATE tg_accounts SET auth_status = 'pending_2fa' WHERE id = ?").run(account.id);
        res.json({ step: '2fa' });
      } else {
        db.prepare(
          "UPDATE tg_accounts SET auth_status = 'authenticated', session_string = ? WHERE id = ?"
        ).run(result.session, account.id);
        res.json({ step: 'done' });
      }
    } else if (account.auth_status === 'pending_2fa' && password) {
      const session = await submitPassword(account.id, password);
      db.prepare(
        "UPDATE tg_accounts SET auth_status = 'authenticated', session_string = ? WHERE id = ?"
      ).run(session, account.id);
      res.json({ step: 'done' });
    } else {
      res.status(400).json({ error: 'Invalid auth state or missing credentials' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
