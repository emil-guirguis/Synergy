-- Who raised a notification. Until now the table recorded only users_id (the
-- RECIPIENT), so an AI-sent message arrived in the bell with no indication of
-- who it came from.
--
-- created_by_name is denormalised on purpose rather than joined at read time:
-- framework/backend/api/base/notifications.ts is shared by apps whose users
-- tables don't match (TBWC keys on uuid, MeterItPro on bigint), and "who sent
-- it" should read as it did when sent even if that person is later renamed.
--
-- Both NULL for system-raised rows (QB sync failures, cron alerts), which is
-- what the bell uses to decide whether to show a From line at all.

ALTER TABLE public.notification
  ADD COLUMN IF NOT EXISTS created_by uuid NULL,
  ADD COLUMN IF NOT EXISTS created_by_name varchar(255) NULL;
