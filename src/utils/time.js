import { DateTime } from 'luxon';

// All Dates are stored in UTC. These helpers convert at the boundary to the
// app's wall-clock timezone, which the legacy UI strings assume.

export const formatLegacy = (date, tz) =>
  date ? DateTime.fromJSDate(date, { zone: tz }).toFormat('yyyy-MM-dd HH:mm:ss') : null;

export const formatHHMM = (date, tz) => (date ? DateTime.fromJSDate(date, { zone: tz }).toFormat('HH:mm') : null);

export const formatDateOnly = (date, tz) => (date ? DateTime.fromJSDate(date, { zone: tz }).toFormat('yyyy-MM-dd') : null);

export const todayInTz = (tz, now = new Date()) => DateTime.fromJSDate(now, { zone: tz }).toFormat('yyyy-MM-dd');

export function wallTimeToDate(dateStr, hour, minute, tz) {
  const dt = DateTime.fromISO(dateStr, { zone: tz }).set({ hour, minute, second: 0, millisecond: 0 });
  if (!dt.isValid) throw new Error(`Invalid date ${dateStr}`);
  return dt.toJSDate();
}

export function isValidDateString(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}

export function addDays(dateStr, days) {
  return DateTime.fromISO(dateStr).plus({ days }).toFormat('yyyy-MM-dd');
}
