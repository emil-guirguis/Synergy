-- 052 — correct the misspelled location type 'Ofice' -> 'Office'
--
-- The value was misspelled in locationSchema.ts enumValues and in
-- locationConfig.ts, which mapped the label 'Office' onto the value 'Ofice'.
-- The UI therefore read correctly while the stored value did not, so any row
-- saved with that option holds 'Ofice'. The code is fixed; this brings the
-- existing rows in line, otherwise those rows no longer match the enum and
-- their Type field renders blank on the form.
--
-- Safe to re-run: the WHERE clause matches nothing once applied.

UPDATE public.location
   SET type = 'Office'
 WHERE type = 'Ofice';
