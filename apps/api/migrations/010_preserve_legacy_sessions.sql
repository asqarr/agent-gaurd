-- 008 originally defaulted password_changed_at to NOW(), which would make
-- every pre-settings session look older than a password change on first deploy.
-- Users with session_version 0 have not used password rotation yet, so their
-- existing seven-day JWT sessions must remain valid.
UPDATE users
SET password_changed_at = TIMESTAMPTZ '1970-01-01 00:00:00+00'
WHERE session_version = 0;
