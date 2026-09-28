const ACTIVE_BUILD_STATES = new Set(['queued', 'processing']);

export function hasActiveBuilds(data) {
  return Array.isArray(data?.builds) && data.builds.some((job) => ACTIVE_BUILD_STATES.has(job?.status));
}

export function mergeLiveBuildHistory(historyItems = [], builds = [], query = '') {
  const live = new Map(builds.map((job) => [job.id, job]));
  const known = new Set(historyItems.map((job) => job.id));
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const matchesQuery = (job) => !normalizedQuery || [job.version, job.domain, job.build_id, job.id]
    .some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
  return [
    ...builds.filter((job) => ACTIVE_BUILD_STATES.has(job.status) && !known.has(job.id) && matchesQuery(job)),
    ...historyItems.map((job) => live.has(job.id) ? { ...job, ...live.get(job.id) } : job),
  ];
}

export function createLiveRefreshScheduler({
  refresh,
  canRefresh,
  isActive = () => false,
  activeDelay = 2000,
  idleDelay = 15000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null;
  let stopped = false;

  function clear() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function schedule(delay = isActive() ? activeDelay : idleDelay) {
    clear();
    if (stopped) return;
    timer = setTimer(run, delay);
  }

  async function run() {
    timer = null;
    if (stopped) return;
    try {
      if (canRefresh()) await refresh();
    } catch {
      // A transient restart or network error must not stop future refreshes.
    } finally {
      schedule();
    }
  }

  return Object.freeze({
    start() { stopped = false; schedule(); },
    reschedule() { if (!stopped) schedule(); },
    refreshNow() { clear(); return run(); },
    stop() { stopped = true; clear(); },
  });
}
