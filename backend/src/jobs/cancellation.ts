const registry = new Map<number, AbortController>();

export function registerJob(logId: number): AbortSignal {
  const ctrl = new AbortController();
  registry.set(logId, ctrl);
  return ctrl.signal;
}

export function unregisterJob(logId: number): void {
  registry.delete(logId);
}

/** Returns false if no running job was found for this logId. */
export function cancelJob(logId: number): boolean {
  const ctrl = registry.get(logId);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

export function isJobRunning(logId: number): boolean {
  return registry.has(logId);
}
