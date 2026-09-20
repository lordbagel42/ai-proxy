export function nextCleanupAt(now: number): number {
  const date = new Date(now);
  date.setUTCHours(3, 17, 0, 0);
  if (date.getTime() <= now) date.setUTCDate(date.getUTCDate() + 1);
  return date.getTime();
}

/** One task at a time. Restarting schedules the next 03:17 UTC; no catch-up writes. */
export function startCleanup(run: () => Promise<unknown>, waitUntil: (task: Promise<unknown>) => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      const operation = Promise.resolve().then(run).then(
        () => { console.log(JSON.stringify({ event: "cleanup_complete" })); },
        () => { console.error(JSON.stringify({ event: "cleanup_failed" })); },
      ).finally(schedule);
      waitUntil(operation);
    }, nextCleanupAt(Date.now()) - Date.now());
    timer.unref();
  };
  schedule();
  return () => { stopped = true; clearTimeout(timer); };
}
