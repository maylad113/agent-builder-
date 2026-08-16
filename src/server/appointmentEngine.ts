import { Business, StaffMember, ServiceItem, Appointment, Holiday } from '../types';

// ---------------------------------------------------------------------------
// Time helpers (HH:MM strings + dates). Pure functions, no I/O.
// ---------------------------------------------------------------------------

export function timeToMinutes(t: string): number {
  const [h, m] = String(t || '').split(':').map(n => parseInt(n, 10) || 0);
  return h * 60 + m;
}

export function minutesToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

export function addMinutes(start: string, durationMinutes: number): string {
  return minutesToTime(timeToMinutes(start) + Math.max(1, durationMinutes));
}

/** Do two [start, end) intervals overlap? Adjacent (back-to-back) allowed. */
export function intervalsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return timeToMinutes(aStart) < timeToMinutes(bEnd) && timeToMinutes(bStart) < timeToMinutes(aEnd);
}

/** Type guard: narrow a transaction result to its failure branch. */
export function isFail<T>(r: { ok: true } | { ok: false; error: string } | T): r is { ok: false; error: string } {
  return typeof r === 'object' && r !== null && (r as any).ok === false;
}

export const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/**
 * Day-of-week for a YYYY-MM-DD date interpreted in the business's timezone.
 * Without timezone handling, `new Date('YYYY-MM-DD')` is UTC midnight and the
 * getUTCDay() can be off by one for non-UTC businesses. We shift by the
 * timezone offset so the weekday matches what the business actually sees.
 */
export function dayOfWeekForDate(dateStr: string, timezone?: string): string {
  // Parse the calendar date as a local wall-clock at 12:00 to avoid DST edge
  // wrapping, then format in the business timezone if Intl is available.
  const noon = `${dateStr}T12:00:00`;
  try {
    if (timezone) {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, weekday: 'long'
      });
      return fmt.format(new Date(noon)).toLowerCase();
    }
  } catch {
    // fall through to UTC
  }
  const d = new Date(`${dateStr}T00:00:00Z`);
  return DAY_NAMES[d.getUTCDay()];
}

/**
 * Interpret a business wall-clock (dateStr + timeStr) as an absolute instant in
 * the BUSINESS timezone (not the server's). Notice/advance comparisons must be
 * measured in the business's own clock: with a UTC server and an Asia/Tehran
 * business, `new Date('2026-01-05T14:00:00')` lands 3.5h after the real slot
 * instant, so a same-day booking with far less than the required notice would
 * be accepted. The offset is probed at local noon of the target date, which
 * avoids DST-transition ambiguity (transitions happen overnight).
 * Falls back to server-local parsing when no timezone is given.
 */
export function zonedSlotInstant(dateStr: string, timeStr: string, timezone?: string): Date {
  if (!timezone) return new Date(`${dateStr}T${timeStr}:00`);
  try {
    const probe = new Date(`${dateStr}T12:00:00`);
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(probe)) p[part.type] = part.value;
    const offsetMs = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - probe.getTime();
    const [h, m] = timeStr.split(':').map(n => parseInt(n, 10) || 0);
    return new Date(Date.UTC(
      parseInt(dateStr.slice(0, 4), 10),
      parseInt(dateStr.slice(5, 7), 10) - 1,
      parseInt(dateStr.slice(8, 10), 10),
      h, m
    ) - offsetMs);
  } catch {
    return new Date(`${dateStr}T${timeStr}:00`);
  }
}

// ---------------------------------------------------------------------------
// Booking-notice policy parsing. The business stores human-readable policy
// strings (e.g. "Appointments can be booked up to 14 days in advance"). We
// extract conservative numeric bounds so the engine can enforce them without
// requiring a schema migration.
// ---------------------------------------------------------------------------

export interface BookingNotice {
  minimumNoticeMinutes: number; // lead time required before a booking
  maximumAdvanceDays: number;   // how far into the future bookings are allowed
}

const DEFAULT_NOTICE: BookingNotice = {
  minimumNoticeMinutes: 0,      // no minimum lead time unless a policy sets one
  maximumAdvanceDays: Infinity,  // no max advance unless a policy sets one
};

export function parseBookingNotice(policies?: { cancellation?: string; refund?: string; bookingNotice?: string }): BookingNotice {
  const text = `${policies?.bookingNotice || ''} ${policies?.cancellation || ''}`.toLowerCase();
  const out: BookingNotice = { ...DEFAULT_NOTICE };

  // "at least N hours before" / "N hours notice"
  const hourMatch = text.match(/(\d+)\s*hours?\s*(?:before|notice|in advance)/);
  if (hourMatch) out.minimumNoticeMinutes = parseInt(hourMatch[1], 10) * 60;
  const minMatch = text.match(/(\d+)\s*minutes?\s*(?:before|notice)/);
  if (minMatch) out.minimumNoticeMinutes = parseInt(minMatch[1], 10);

  // "up to N days in advance" / "N days ahead"
  const dayMatch = text.match(/(\d+)\s*days?\s*(?:in advance|ahead|ahead of)/);
  if (dayMatch) out.maximumAdvanceDays = parseInt(dayMatch[1], 10);

  return out;
}

// ---------------------------------------------------------------------------
// Core availability / validation logic (pure; operates on in-memory arrays).
// Used by tools.ts so the booking + check_availability tools share ONE source
// of truth, and so the engine is unit-testable without HTTP.
// ---------------------------------------------------------------------------

export interface SlotValidation {
  ok: boolean;
  error?: string;
  endTime?: string;
  staffMember?: StaffMember | null;
}

/** Is `dateStr` a business holiday? */
export function isHoliday(business: Business, dateStr: string): boolean {
  return !!(business.holidays || []).some(h => h.date === dateStr);
}

/**
 * Find an eligible staff member for a service on a given date/time, honoring
 * per-staff working hours, servicesHandled, and timeOff. Falls back to the
 * first staff member (or null) when no per-staff hours are configured.
 */
export function findEligibleStaff(
  business: Business,
  staffMembers: StaffMember[],
  service: ServiceItem,
  dateStr: string,
  startTime: string,
  endTime: string
): StaffMember | null {
  const dayName = dayOfWeekForDate(dateStr, business.timezone);
  const eligible = staffMembers.filter(
    s => s.businessId === business.id &&
      (s.servicesHandled.length === 0 || s.servicesHandled.includes(service.id))
  );
  // Prefer a staff member whose workingHours explicitly cover this slot and who
  // is not on timeOff that day.
  const withHours = eligible.find(s => {
    if ((s.timeOff || []).some(t => t.date === dateStr)) return false;
    const sw = (s.workingHours || []).find(h => h.day === dayName);
    if (!sw || !sw.isOpen) return false;
    return timeToMinutes(startTime) >= timeToMinutes(sw.openTime) &&
           timeToMinutes(endTime) <= timeToMinutes(sw.closeTime);
  });
  if (withHours) return withHours;
  // Fall back ONLY to staff with no working-hours schedule configured (their
  // coverage defaults to the business hours). Never fall back to a staff member
  // whose schedule explicitly excludes this slot — that would book a time no
  // one is scheduled to work.
  const fallback = eligible.find(s => {
    if ((s.timeOff || []).some(t => t.date === dateStr)) return false;
    const schedule = s.workingHours || [];
    if (schedule.length === 0) return true; // no schedule → business hours apply
    const sw = schedule.find(h => h.day === dayName);
    if (!sw || !sw.isOpen) return false;    // has a schedule but not this day / closed
    return timeToMinutes(startTime) >= timeToMinutes(sw.openTime) &&
           timeToMinutes(endTime) <= timeToMinutes(sw.closeTime);
  });
  return fallback || null;
}

/**
 * Validate that a proposed [startTime, endTime] booking is legal for the
 * business: open that day, not a holiday, within hours, respects minimum
 * notice and maximum advance, and the service fits before close.
 */
export function validateSlot(
  business: Business,
  service: ServiceItem,
  dateStr: string,
  startTime: string,
  now: Date = new Date()
): SlotValidation {
  if (isHoliday(business, dateStr)) {
    return { ok: false, error: `The business is closed on ${dateStr} (holiday).` };
  }
  const dayName = dayOfWeekForDate(dateStr, business.timezone);
  const dayHours = business.hours.find(h => h.day === dayName);
  if (!dayHours || !dayHours.isOpen) {
    return { ok: false, error: `The business is closed on ${dayName}s.` };
  }
  const duration = Math.max(1, service.durationMinutes || 30);
  const endTime = addMinutes(startTime, duration);
  if (timeToMinutes(startTime) < timeToMinutes(dayHours.openTime) ||
      timeToMinutes(endTime) > timeToMinutes(dayHours.closeTime)) {
    return { ok: false, error: `Requested time ${startTime}-${endTime} is outside opening hours (${dayHours.openTime}-${dayHours.closeTime}) on ${dayName}.`, endTime };
  }

  // Booking notice / advance rules — measured in the BUSINESS timezone so the
  // comparison is honest for businesses whose clock differs from the server's.
  const notice = parseBookingNotice(business.policies);
  const slotLocal = zonedSlotInstant(dateStr, startTime, business.timezone);
  const diffMs = slotLocal.getTime() - now.getTime();
  const diffMin = diffMs / 60000;
  if (diffMin < notice.minimumNoticeMinutes) {
    return { ok: false, error: `This time is too soon — please book at least ${notice.minimumNoticeMinutes} minutes in advance.`, endTime };
  }
  const advanceDays = diffMs / 86400000;
  if (advanceDays > notice.maximumAdvanceDays) {
    return { ok: false, error: `Appointments can only be booked up to ${notice.maximumAdvanceDays} days in advance.`, endTime };
  }
  return { ok: true, endTime, staffMember: null };
}

/**
 * Generate available slots for a service on a date, respecting business hours,
 * staff coverage, holidays, service duration + buffer, and existing bookings.
 * Slots are aligned to a fixed grid (default 30 min) so the AI/customer see
 * consistent, bookable options.
 */
export function generateAvailableSlots(
  business: Business,
  staffMembers: StaffMember[],
  service: ServiceItem,
  existingAppointments: Appointment[],
  dateStr: string,
  now: Date = new Date(),
  slotGridMinutes = 30
): string[] {
  if (isHoliday(business, dateStr)) return [];
  const dayName = dayOfWeekForDate(dateStr, business.timezone);
  const dayHours = business.hours.find(h => h.day === dayName);
  if (!dayHours || !dayHours.isOpen) return [];

  const duration = Math.max(1, service.durationMinutes || 30);
  const bufferAfter = Math.max(0, service.bufferMinutesAfter || 0);
  const open = timeToMinutes(dayHours.openTime);
  const close = timeToMinutes(dayHours.closeTime);

  const notice = parseBookingNotice(business.policies);
  const minSlotLocalMs = now.getTime() + notice.minimumNoticeMinutes * 60000;

  const slots: string[] = [];
  for (let t = open; t + duration + bufferAfter <= close; t += slotGridMinutes) {
    const start = minutesToTime(t);
    const end = minutesToTime(t + duration);
    const blockEnd = minutesToTime(t + duration + bufferAfter);

    // Honor minimum notice: skip slots that are too soon (business-timezone clock).
    const slotLocal = zonedSlotInstant(dateStr, start, business.timezone);
    if (slotLocal.getTime() < minSlotLocalMs) continue;

    // If the business has staff members, require at least one who can cover
    // this slot. A business with no staff configured is treated as covering
    // all slots itself (the owner/staff-on-duty handles everything).
    if (staffMembers.length > 0) {
      const staff = findEligibleStaff(business, staffMembers, service, dateStr, start, end);
      if (!staff) continue;
    }

    // Overlap check against existing non-cancelled appointments. Both the new
    // slot AND each existing appointment extend by their own service buffer, so
    // a booking at 14:30 is blocked by an existing 14:00-14:30 appt that needs
    // a 15-min turnaround (its effective block is 14:00-14:45).
    const conflict = existingAppointments.some(a => {
      if (a.businessId !== business.id || a.date !== dateStr || a.status === 'CANCELLED') return false;
      const existingService = business.services.find(s => s.id === a.serviceId);
      const existingBuffer = Math.max(0, existingService?.bufferMinutesAfter || 0);
      const aBlockEnd = existingBuffer > 0 ? addMinutes(a.endTime, existingBuffer) : a.endTime;
      return intervalsOverlap(start, blockEnd, a.startTime, aBlockEnd);
    });
    if (!conflict) slots.push(start);
  }
  return slots;
}
