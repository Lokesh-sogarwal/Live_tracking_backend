// One trip lifecycle for the whole system: the simulation (which trips may run), the schedule
// API, the public timetable and the app all use these rules. Times are absolute instants (UTC
// in MongoDB); schedule dates are IST service days (APP_TIMEZONE).
//
// Legacy field naming: `arrivalTime` is when a trip STARTS, `departureTime` its scheduled END.
// "Departed" means the simulation (or a device) has made progress: currentIndex > 0.
//
//   cancelled          status contains "cancel"
//   completed          reached the destination on time or early      (status "arrived")
//   delayed_completed  reached it after the scheduled end              (status "delayed_completed")
//   invalid            start is not before end — never runs
//   upcoming           start still in the future
//   not_started        start has come, window still open, not departed yet (eligible to start)
//   running            departed, not reached, within its window
//   delayed            departed, not reached, and late (past the scheduled end, or set "delayed")
//   did_not_depart     window passed without departing — it is not started late
//
// A scheduled end passing never completes a trip; only reaching the destination does.
export const ACTIVE = new Set(['not_started', 'running', 'delayed']);

export function tripLifecycle(s, now = new Date()) {
  const status = String(s.status || '').toLowerCase();
  if (/cancel/.test(status)) return 'cancelled';
  if (s.isReached) return status === 'delayed_completed' ? 'delayed_completed' : 'completed';
  const start = new Date(s.arrivalTime);
  const end = new Date(s.departureTime);
  if (!(start < end)) return 'invalid';
  const departed = (s.currentIndex || 0) > 0;
  if (departed) return status === 'delayed' || now > end ? 'delayed' : 'running';
  if (now < start) return 'upcoming';
  if (now < end) return 'not_started';
  return 'did_not_depart';
}

// Whether the simulation may move this trip now (start it, or keep it going).
export const isEligibleToRun = (s, now = new Date()) => ACTIVE.has(tripLifecycle(s, now));

// Fields every schedule payload carries, so screens don't re-derive them in the browser's
// timezone: exact start/end instants, whether the bus has departed, and the lifecycle.
export const lifecycleFields = (s, now = new Date()) => ({
  start_at: new Date(s.arrivalTime).toISOString(),
  end_at: new Date(s.departureTime).toISOString(),
  started: (s.currentIndex || 0) > 0,
  lifecycle: tripLifecycle(s, now),
});
