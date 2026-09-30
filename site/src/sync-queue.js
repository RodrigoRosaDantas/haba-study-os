const RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];

export function isSameSyncOperation(current, attempted) {
  if (!current || !attempted || current.operationId !== attempted.operationId) return false;
  if (current.updatedAt !== attempted.updatedAt) return false;
  return JSON.stringify(current.payload) === JSON.stringify(attempted.payload);
}

export function deferFailedOperation(item, reason, now = Date.now()) {
  const attempts = Math.max(0, Number(item?.attempts) || 0) + 1;
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
  return {
    ...item,
    status: "PENDING",
    attempts,
    lastAttemptAt: new Date(now).toISOString(),
    lastError: String(reason || "Falha temporária de sincronização").slice(0, 180),
    nextAttemptAt: new Date(now + delay).toISOString()
  };
}

export function millisecondsUntilQueueDue(queue, now = Date.now()) {
  const pending = (queue || []).filter(item => item?.status === "PENDING");
  if (!pending.length) return null;
  const next = Math.min(...pending.map(item => {
    const due = Date.parse(item.nextAttemptAt || "");
    return Number.isFinite(due) ? due : now;
  }));
  return Math.max(0, next - now);
}

export function isQueueItemDue(item, now = Date.now()) {
  if (item?.status !== "PENDING") return false;
  const due = Date.parse(item.nextAttemptAt || "");
  return !Number.isFinite(due) || due <= now;
}
