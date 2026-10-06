-- Who raised a notification. Until now the table recorded only users_id (the
-- RECIPIENT), so a user-sent message arrived in the bell with no indication of
-- who it came from. Mirrors TBWC migration 074; created_by is bigint here
-- because MeterItPro keys public.users on bigint, not uuid.
--
-- created_by_name is denormalised on purpose rather than joined at read time:
-- framework/backend/api/base/notifications.ts is shared by both apps and their
-- users tables don't match, and "who sent it" should read as it did when sent
-- even if that person is later renamed.
--
-- Both NULL for system-raised rows (the notificationRunner's threshold alerts),
-- which is what the bell uses to decide whether to show a From line at all.

ALTER TABLE public.notification
  ADD COLUMN IF NOT EXISTS created_by bigint NULL,
  ADD COLUMN IF NOT EXISTS created_by_name varchar(255) NULL;
