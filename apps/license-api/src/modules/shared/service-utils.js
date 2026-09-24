export function iso(clock) {
  return clock().toISOString();
}

export function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

export function startOfRollingDay(date) {
  return new Date(date.getTime() - 24 * 60 * 60 * 1000).toISOString();
}

export function parseJsonObject(value, fallback) {
  try {
    const parsed = JSON.parse(value ?? 'null');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}
