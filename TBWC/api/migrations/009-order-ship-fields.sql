-- Order module ship fields: rename no_later_than -> ship_no_later_than, add
-- shipped_date, add jay (checkbox). All TBWC-owned columns on qb_sales_order
-- (the QBWC upsert never touches them). Legacy public."order" and
-- public.inventory were dropped manually on 2026-09-06 (no DDL here for that).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'qb_sales_order'
                AND column_name = 'no_later_than')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'qb_sales_order'
                AND column_name = 'ship_no_later_than') THEN
    ALTER TABLE public.qb_sales_order RENAME COLUMN no_later_than TO ship_no_later_than;
  END IF;
END $$;

ALTER TABLE public.qb_sales_order
  ADD COLUMN IF NOT EXISTS shipped_date date,
  ADD COLUMN IF NOT EXISTS jay boolean NOT NULL DEFAULT false;
