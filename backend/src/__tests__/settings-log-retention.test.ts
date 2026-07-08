// Tests for the log_retention_days setting: whitelist membership and the
// immediate purge triggered when the value is saved.

const { mockRun, mockAll, mockPrepare, mockPurge, mockRefresh } = vi.hoisted(() => {
  const mockRun = vi.fn();
  const mockAll = vi.fn().mockReturnValue([]);
  const mockPrepare = vi.fn().mockReturnValue({
    run: mockRun,
    all: mockAll,
    get: vi.fn(),
  });
  return {
    mockRun,
    mockAll,
    mockPrepare,
    mockPurge: vi.fn(),
    mockRefresh: vi.fn(),
  };
});

vi.mock('../db/database', () => ({
  db: {
    prepare: mockPrepare,
    transaction: (fn: any) => fn,
  },
}));
vi.mock('../scheduler', () => ({
  refreshScheduler: mockRefresh,
  purgeOldLogs: mockPurge,
}));
vi.mock('../jobs/runner', () => ({ parseTgProxy: vi.fn() }));
vi.mock('socks', () => ({ SocksClient: { createConnection: vi.fn() } }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import settingsRouter, { ALLOWED_KEYS } from '../routes/settings';

/** Pulls a route handler out of the Express router so it can be called directly. */
function routeHandler(method: string, path: string) {
  const layer = (settingsRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[0].handle as (req: any, res: any) => void;
}

function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  return res;
}

const putSettings = routeHandler('put', '/');

beforeEach(() => {
  vi.clearAllMocks();
  mockAll.mockReturnValue([]);
});

describe('log_retention_days setting', () => {
  it('is an allowed settings key', () => {
    expect(ALLOWED_KEYS).toContain('log_retention_days');
  });

  it('persists the value and purges immediately when saved', () => {
    putSettings({ body: { log_retention_days: '30' } }, makeRes());

    expect(mockRun).toHaveBeenCalledWith('log_retention_days', '30');
    expect(mockPurge).toHaveBeenCalledTimes(1);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('does not purge when the retention setting is untouched', () => {
    putSettings({ body: { default_timezone: 'UTC' } }, makeRes());

    expect(mockRun).toHaveBeenCalledWith('default_timezone', 'UTC');
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it('is returned to the client by GET /settings', () => {
    mockAll.mockReturnValue([{ key: 'log_retention_days', value: '7' }]);
    const res = makeRes();

    routeHandler('get', '/')({}, res);

    expect(res.body.log_retention_days).toBe('7');
  });
});
