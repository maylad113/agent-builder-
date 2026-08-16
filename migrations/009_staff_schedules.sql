-- 009_staff_schedules.sql
-- Persist per-staff working hours and time off. The appointment engine already
-- honors StaffMember.workingHours / timeOff when present, but the original
-- staff_members table only stored services_handled, so schedules were silently
-- dropped on write and staff-hours enforcement could never work in production.
-- Columns are nullable: NULL means "no schedule configured" (business hours
-- apply), matching the engine's fallback semantics.
ALTER TABLE staff_members ADD COLUMN working_hours TEXT DEFAULT '[]';
ALTER TABLE staff_members ADD COLUMN time_off TEXT DEFAULT '[]';
