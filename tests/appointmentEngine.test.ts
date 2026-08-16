import { describe, it, expect } from 'vitest';
import {
  timeToMinutes, minutesToTime, addMinutes, intervalsOverlap,
  dayOfWeekForDate, parseBookingNotice, isHoliday, validateSlot,
  generateAvailableSlots, findEligibleStaff, zonedSlotInstant
} from '../src/server/appointmentEngine';
import type { Business, StaffMember, ServiceItem, Appointment } from '../src/types';

/**
 * Pick a near-term open weekday (Mon–Sat) relative to today, so tests are
 * date-independent and never land on a past date or the closed Sunday.
 * `addDays` shifts N days forward from today before scanning for an open day.
 */
function nextOpenDay(addDays = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + addDays);
  while (d.getDay() === 0) d.setDate(d.getDate() + 1); // skip Sunday (closed)
  return d.toISOString().split('T')[0];
}
function nextSunday(): string {
  const d = new Date();
  const day = d.getDay();
  const add = (7 - day) % 7 || 7;
  d.setDate(d.getDate() + add);
  return d.toISOString().split('T')[0];
}
const OPEN_DATE = nextOpenDay();      // a near-term Mon–Sat
const OPEN_DATE2 = nextOpenDay(3);    // another open weekday
const SUN_DATE = nextSunday();        // the next Sunday (closed)
const MON_DATE = nextOpenDay(2);      // used for staff-hours Monday test
// Compute an in-hours start time guaranteed to leave room: use 14:00.

// A reusable open Mon–Sat (closed Sun) business in Asia/Tehran with a 30-min
// "Haircut" service. Policies default to empty (no notice/advance limits).
function makeBusiness(over: Partial<Business> = {}): Business {
  return {
    id: 'b1', name: 'Test', type: 'barbershop', description: '', location: '',
    language: 'en', currency: 'toman', timezone: 'Asia/Tehran',
    hours: ['monday','tuesday','wednesday','thursday','friday','saturday'].map(day => ({
      day: day as any, isOpen: true, openTime: '09:00', closeTime: '20:00'
    })).concat([{ day: 'sunday' as any, isOpen: false, openTime: '09:00', closeTime: '20:00' }]),
    services: [{ id: 's1', name: 'Haircut', price: 100, durationMinutes: 30, description: '' }],
    faqs: [], policies: { cancellation: '', refund: '', bookingNotice: '' },
    communicationStyle: '', status: 'ACTIVE', createdAt: '', updatedAt: '',
    ...over,
  } as Business;
}
const svc = (over: Partial<ServiceItem> = {}) => ({ id: 's1', name: 'Haircut', price: 100, durationMinutes: 30, description: '', ...over }) as ServiceItem;

describe('time helpers', () => {
  it('timeToMinutes / minutesToTime round-trip', () => {
    expect(timeToMinutes('14:30')).toBe(870);
    expect(minutesToTime(870)).toBe('14:30');
    expect(addMinutes('09:00', 30)).toBe('09:30');
  });
  it('intervalsOverlap: adjacent allowed, true overlap rejected', () => {
    expect(intervalsOverlap('09:00','09:30','09:30','10:00')).toBe(false); // adjacent
    expect(intervalsOverlap('09:00','09:30','09:15','09:45')).toBe(true);  // overlap
    expect(intervalsOverlap('09:00','10:00','09:00','10:00')).toBe(true);  // identical
  });
});

describe('dayOfWeekForDate (timezone-aware)', () => {
  it('respects the business timezone for edge-of-day dates', () => {
    // 2026-01-01 is a Thursday in UTC and also in Tehran (UTC+3:30).
    expect(dayOfWeekForDate('2026-01-01', 'Asia/Tehran')).toBe('thursday');
    // 2026-01-04 is a Sunday.
    expect(dayOfWeekForDate('2026-01-04', 'Asia/Tehran')).toBe('sunday');
  });
  it('falls back to UTC when no timezone given', () => {
    expect(dayOfWeekForDate('2026-01-01')).toBe('thursday');
  });
});

describe('zonedSlotInstant (business-timezone wall clock)', () => {
  it('interprets wall-clock in the business timezone, not the server timezone', () => {
    // Asia/Tehran is UTC+3:30 year-round (no DST since 2022): 14:00 Tehran == 10:30 UTC.
    const inst = zonedSlotInstant('2026-01-05', '14:00', 'Asia/Tehran');
    expect(inst.toISOString()).toBe('2026-01-05T10:30:00.000Z');
  });
  it('respects DST: a summer NY slot is UTC-4, a winter one UTC-5', () => {
    // America/New_York: EDT in July (UTC-4), EST in January (UTC-5).
    expect(zonedSlotInstant('2026-07-15', '12:00', 'America/New_York').toISOString()).toBe('2026-07-15T16:00:00.000Z');
    expect(zonedSlotInstant('2026-01-15', '12:00', 'America/New_York').toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });
  it('falls back to server-local parsing when no timezone is given', () => {
    const inst = zonedSlotInstant('2026-01-05', '14:00');
    expect(inst.getFullYear()).toBe(2026);
  });
});

describe('parseBookingNotice', () => {
  it('defaults: no minimum, no max advance', () => {
    const n = parseBookingNotice({});
    expect(n.minimumNoticeMinutes).toBe(0);
    expect(n.maximumAdvanceDays).toBe(Infinity);
  });
  it('parses "up to N days in advance"', () => {
    expect(parseBookingNotice({ bookingNotice: 'Appointments can be booked up to 14 days in advance.' }).maximumAdvanceDays).toBe(14);
  });
  it('parses "at least N hours before"', () => {
    expect(parseBookingNotice({ cancellation: 'Please cancel at least 2 hours before.' }).minimumNoticeMinutes).toBe(120);
  });
  it('parses "N minutes notice"', () => {
    expect(parseBookingNotice({ bookingNotice: '30 minutes notice required.' }).minimumNoticeMinutes).toBe(30);
  });
});

describe('isHoliday', () => {
  it('detects configured holiday dates', () => {
    const b = makeBusiness({ holidays: [{ date: OPEN_DATE, name: 'Closed Day' }] });
    expect(isHoliday(b, OPEN_DATE)).toBe(true);
    expect(isHoliday(b, OPEN_DATE2)).toBe(false);
  });
});

describe('validateSlot', () => {
  it('rejects a holiday', () => {
    const b = makeBusiness({ holidays: [{ date: OPEN_DATE, name: 'NY' }] });
    expect(validateSlot(b, svc(), OPEN_DATE, '12:00').ok).toBe(false);
  });
  it('rejects a closed day (Sunday)', () => {
    expect(validateSlot(makeBusiness(), svc(), SUN_DATE, '12:00').ok).toBe(false);
  });
  it('rejects outside opening hours', () => {
    const r = validateSlot(makeBusiness(), svc(), OPEN_DATE, '07:00'); // opens 09:00
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/outside opening hours/i);
  });
  it('rejects a slot that overflows close time (service duration)', () => {
    // 30-min service at 19:45 -> 20:15 > 20:00 close
    const r = validateSlot(makeBusiness(), svc(), OPEN_DATE, '19:45');
    expect(r.ok).toBe(false);
  });
  it('accepts a valid in-hours slot and computes endTime', () => {
    const r = validateSlot(makeBusiness(), svc(), OPEN_DATE, '14:00');
    expect(r.ok).toBe(true);
    expect(r.endTime).toBe('14:30');
  });
  it('enforces max-advance policy', () => {
    const b = makeBusiness({ policies: { cancellation: '', refund: '', bookingNotice: 'up to 7 days in advance' } });
    const future = new Date(); future.setDate(future.getDate() + 20);
    // Make sure the future date is an open day (skip Sunday) for a clean advance check.
    while (future.getDay() === 0) future.setDate(future.getDate() + 1);
    const dateStr = future.toISOString().split('T')[0];
    const r = validateSlot(b, svc(), dateStr, '14:00');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/in advance/i);
  });
  it('enforces minimum-notice policy', () => {
    // Use a business with 24h hours so the only failing rule is minimum notice.
    const b = makeBusiness({
      hours: ['monday','tuesday','wednesday','thursday','friday','saturday'].map(day => ({
        day: day as any, isOpen: true, openTime: '00:00', closeTime: '23:59'
      })).concat([{ day: 'sunday' as any, isOpen: false, openTime: '00:00', closeTime: '23:59' }]),
      policies: { cancellation: 'at least 2 hours before', refund: '', bookingNotice: '' }
    });
    // Pick a near-term open day and a time ~30 min from now (within 24h hours).
    const soon = new Date(Date.now() + 30 * 60000); // 30 min from now
    let dateStr = soon.toISOString().split('T')[0];
    // If that date is Sunday, push to the next open day.
    while (new Date(`${dateStr}T00:00:00Z`).getUTCDay() === 0) {
      soon.setDate(soon.getDate() + 1);
      dateStr = soon.toISOString().split('T')[0];
    }
    const timeStr = `${soon.getHours().toString().padStart(2,'0')}:${soon.getMinutes().toString().padStart(2,'0')}`;
    const r = validateSlot(b, svc(), dateStr, timeStr, new Date());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too soon|in advance/i);
  });
  it('enforces minimum notice measured in the BUSINESS timezone, not the server timezone', () => {
    // Business is Asia/Tehran (UTC+3:30) with a 2-hour notice policy. The slot
    // 2026-01-05 14:00 Tehran is 10:30 UTC. now = 10:30 UTC == exactly 14:00
    // Tehran, i.e. ZERO notice — must be rejected. Parsing the wall-clock in
    // the server's UTC clock would make the slot look 3.5h away and wrongly
    // accept it.
    const b = makeBusiness({
      policies: { cancellation: 'at least 2 hours before', refund: '', bookingNotice: '' }
    });
    const now = new Date('2026-01-05T10:30:00Z'); // 14:00 Tehran
    const r = validateSlot(b, svc(), '2026-01-05', '14:00', now);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too soon|in advance/i);
  });
  it('accepts a slot with sufficient notice measured in the business timezone', () => {
    const b = makeBusiness({
      policies: { cancellation: 'at least 2 hours before', refund: '', bookingNotice: '' }
    });
    // 2026-01-05 14:00 Tehran = 10:30 UTC; now = 07:30 UTC = 11:00 Tehran → 3h notice.
    const now = new Date('2026-01-05T07:30:00Z');
    const r = validateSlot(b, svc(), '2026-01-05', '14:00', now);
    expect(r.ok).toBe(true);
  });
});

describe('findEligibleStaff', () => {
  it('prefers a staff member whose workingHours cover the slot and who is not on timeOff', () => {
    const b = makeBusiness();
    const day = dayOfWeekForDate(MON_DATE, 'Asia/Tehran');
    const staff: StaffMember[] = [
      { id: 'st1', businessId: 'b1', name: 'A', role: 'r', servicesHandled: ['s1'] },
      { id: 'st2', businessId: 'b1', name: 'B', role: 'r', servicesHandled: ['s1'],
        workingHours: [{ day: day as any, isOpen: true, openTime: '10:00', closeTime: '12:00' }] },
    ];
    // Slot 11:00-11:30 falls within st2's 10-12 hours on MON_DATE.
    const s = findEligibleStaff(b, staff, svc(), MON_DATE, '11:00', '11:30');
    expect(s?.id).toBe('st2');
  });
  it('skips staff on timeOff that day', () => {
    const b = makeBusiness();
    const staff: StaffMember[] = [
      { id: 'st1', businessId: 'b1', name: 'A', role: 'r', servicesHandled: ['s1'],
        timeOff: [{ date: OPEN_DATE, name: 'sick' }] },
      { id: 'st2', businessId: 'b1', name: 'B', role: 'r', servicesHandled: ['s1'] },
    ];
    const s = findEligibleStaff(b, staff, svc(), OPEN_DATE, '11:00', '11:30');
    expect(s?.id).toBe('st2');
  });
  it('skips staff who do not handle the service', () => {
    const b = makeBusiness();
    const staff: StaffMember[] = [
      { id: 'st1', businessId: 'b1', name: 'A', role: 'r', servicesHandled: ['other'] },
    ];
    const s = findEligibleStaff(b, staff, svc(), OPEN_DATE, '11:00', '11:30');
    expect(s).toBeNull();
  });
  it('returns null when every staff member\'s schedule excludes the slot (no fallback to a scheduled-out member)', () => {
    const b = makeBusiness();
    const day = dayOfWeekForDate(MON_DATE, 'Asia/Tehran');
    const staff: StaffMember[] = [
      { id: 'st1', businessId: 'b1', name: 'A', role: 'r', servicesHandled: ['s1'],
        workingHours: [{ day: day as any, isOpen: true, openTime: '09:00', closeTime: '12:00' }] },
      { id: 'st2', businessId: 'b1', name: 'B', role: 'r', servicesHandled: ['s1'],
        workingHours: [{ day: day as any, isOpen: true, openTime: '13:00', closeTime: '17:00' }] },
    ];
    // 18:00 is inside business hours (09:00-20:00) but outside BOTH schedules.
    const s = findEligibleStaff(b, staff, svc(), MON_DATE, '18:00', '18:30');
    expect(s).toBeNull();
  });
  it('falls back to a staff member with no schedule configured (business hours apply)', () => {
    const b = makeBusiness();
    const day = dayOfWeekForDate(MON_DATE, 'Asia/Tehran');
    const staff: StaffMember[] = [
      { id: 'st1', businessId: 'b1', name: 'A', role: 'r', servicesHandled: ['s1'],
        workingHours: [{ day: day as any, isOpen: true, openTime: '09:00', closeTime: '12:00' }] },
      { id: 'st2', businessId: 'b1', name: 'B', role: 'r', servicesHandled: ['s1'] },
    ];
    // 15:00 is outside st1's hours; st2 has no schedule → covers via business hours.
    const s = findEligibleStaff(b, staff, svc(), MON_DATE, '15:00', '15:30');
    expect(s?.id).toBe('st2');
  });
});

describe('generateAvailableSlots', () => {
  it('returns [] on a holiday', () => {
    const b = makeBusiness({ holidays: [{ date: OPEN_DATE, name: 'NY' }] });
    expect(generateAvailableSlots(b, [], svc(), [], OPEN_DATE)).toEqual([]);
  });
  it('returns [] on a closed day', () => {
    expect(generateAvailableSlots(makeBusiness(), [], svc(), [], SUN_DATE)).toEqual([]);
  });
  it('excludes slots overlapping existing appointments', () => {
    const b = makeBusiness();
    const existing: Appointment[] = [{
      id: 'a1', businessId: 'b1', serviceId: 's1', serviceName: 'Haircut',
      customerId: 'c1', customerName: 'X', customerPhone: 'p',
      date: OPEN_DATE, startTime: '14:00', endTime: '14:30', status: 'CONFIRMED', createdAt: ''
    }];
    const slots = generateAvailableSlots(b, [], svc(), existing, OPEN_DATE);
    expect(slots).not.toContain('14:00');
    // adjacent 14:30 should still be available (no overlap, no buffer)
    expect(slots).toContain('14:30');
  });
  it('honors service buffer: a booked slot blocks the following buffer window', () => {
    // The business's service itself carries a 15-min buffer, so both the new
    // slot and the existing appointment block their trailing turnaround time.
    const buffered = svc({ bufferMinutesAfter: 15 });
    const b = makeBusiness({ services: [buffered] });
    const existing: Appointment[] = [{
      id: 'a1', businessId: 'b1', serviceId: 's1', serviceName: 'Haircut',
      customerId: 'c1', customerName: 'X', customerPhone: 'p',
      date: OPEN_DATE2, startTime: '14:00', endTime: '14:30', status: 'CONFIRMED', createdAt: ''
    }];
    const slots = generateAvailableSlots(b, [], buffered, existing, OPEN_DATE2);
    // 14:00 blocked (the appt). 14:30 is within the 15-min buffer (14:30-14:45) -> blocked.
    expect(slots).not.toContain('14:00');
    expect(slots).not.toContain('14:30');
    // 15:00 is past the buffer -> available.
    expect(slots).toContain('15:00');
  });
  it('excludes slots no staff member is scheduled to work', () => {
    const b = makeBusiness();
    const day = dayOfWeekForDate(MON_DATE, 'Asia/Tehran');
    const staff: StaffMember[] = [
      { id: 'st1', businessId: 'b1', name: 'A', role: 'r', servicesHandled: ['s1'],
        workingHours: [{ day: day as any, isOpen: true, openTime: '09:00', closeTime: '12:00' }] },
      { id: 'st2', businessId: 'b1', name: 'B', role: 'r', servicesHandled: ['s1'],
        workingHours: [{ day: day as any, isOpen: true, openTime: '13:00', closeTime: '17:00' }] },
    ];
    const slots = generateAvailableSlots(b, staff, svc(), [], MON_DATE);
    expect(slots).toContain('10:00'); // st1 covers
    expect(slots).toContain('14:00'); // st2 covers
    expect(slots).not.toContain('18:00'); // inside business hours, but no staff scheduled
  });
});
