-- More QB SalesOrderRet header fields, matching what the "TBWC Sales Order"
-- custom template actually shows in QB Desktop (confirmed against live raw
-- SalesOrderRet for TBWC 5683, 2026-09-06): BillAddressBlock/ShipAddressBlock
-- (the form's "Name/Address"/"Ship To" boxes), TermsRef (the form labels this
-- "Freight Terms" even though it's QB's standard Terms field — this company's
-- terms list holds freight-handling codes like "PPC"/"Allowed", not payment
-- terms), ShipMethodRef ("Ship Via"), CustomerMsgRef (repurposed by this
-- company as the order's "Contact" line: "Name / email / phone"), and
-- CustomerSalesTaxCodeRef ("Customer Tax Code").
--
-- data_ext captures any DataExtRet (QB custom field) blocks generically —
-- salesOrder.ts now requests OwnerID -1 to pull private custom fields too, on
-- the chance the template's "Job Name" box turns out to be one; nothing found
-- on the confirmed no DataExtRet on either sample order, but the form request
-- didn't ask for private ones before, so this needs a live re-sync to confirm.
-- Once we see real data here we can promote the right key to a named column
-- the way migration 010 did for the other header fields.

ALTER TABLE public.qb_sales_order
  ADD COLUMN IF NOT EXISTS bill_address_block text,
  ADD COLUMN IF NOT EXISTS ship_address_block text,
  ADD COLUMN IF NOT EXISTS freight_terms      text,  -- TermsRef.FullName
  ADD COLUMN IF NOT EXISTS ship_via           text,  -- ShipMethodRef.FullName
  ADD COLUMN IF NOT EXISTS contact            text,  -- CustomerMsgRef.FullName
  ADD COLUMN IF NOT EXISTS customer_tax_code  text,  -- CustomerSalesTaxCodeRef.FullName
  ADD COLUMN IF NOT EXISTS data_ext           jsonb; -- [{name,value,ownerId}], OwnerID -1 pull

-- Same rationale as migration 011: the raw jsonb slice already stored on each
-- row has these header fields (they all sit before line items), so backfill
-- immediately instead of waiting for every order's next incremental re-sync.
UPDATE public.qb_sales_order so
SET bill_address_block = COALESCE(so.bill_address_block, calc.bill_address_block),
    ship_address_block = COALESCE(so.ship_address_block, calc.ship_address_block),
    freight_terms = COALESCE(so.freight_terms, calc.freight_terms),
    ship_via = COALESCE(so.ship_via, calc.ship_via),
    contact = COALESCE(so.contact, calc.contact),
    customer_tax_code = COALESCE(so.customer_tax_code, calc.customer_tax_code)
FROM (
  SELECT
    qb_sales_order_id,
    NULLIF(array_to_string(ARRAY(
      SELECT (regexp_matches(blk.b, '<Addr[1-5]>([^<]*)</Addr[1-5]>', 'g'))[1]
      FROM (SELECT (regexp_match(raw->>'ret', '<BillAddressBlock>([\s\S]*?)</BillAddressBlock>'))[1] AS b) blk
    ), E'\n'), '') AS bill_address_block,
    NULLIF(array_to_string(ARRAY(
      SELECT (regexp_matches(blk.b, '<Addr[1-5]>([^<]*)</Addr[1-5]>', 'g'))[1]
      FROM (SELECT (regexp_match(raw->>'ret', '<ShipAddressBlock>([\s\S]*?)</ShipAddressBlock>'))[1] AS b) blk
    ), E'\n'), '') AS ship_address_block,
    (regexp_match(raw->>'ret', '<TermsRef>\s*<ListID>[^<]*</ListID>\s*<FullName>([^<]*)</FullName>'))[1] AS freight_terms,
    (regexp_match(raw->>'ret', '<ShipMethodRef>\s*<ListID>[^<]*</ListID>\s*<FullName>([^<]*)</FullName>'))[1] AS ship_via,
    replace(replace(replace(replace(replace(
      (regexp_match(raw->>'ret', '<CustomerMsgRef>\s*<ListID>[^<]*</ListID>\s*<FullName>([^<]*)</FullName>'))[1],
      '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&apos;', '''') AS contact,
    (regexp_match(raw->>'ret', '<CustomerSalesTaxCodeRef>\s*<ListID>[^<]*</ListID>\s*<FullName>([^<]*)</FullName>'))[1] AS customer_tax_code
  FROM public.qb_sales_order
  WHERE raw->>'ret' IS NOT NULL
) calc
WHERE so.qb_sales_order_id = calc.qb_sales_order_id;

-- Same generic custom-field capture on Customer, in case "Job Name" is a
-- private custom field on the customer/job record rather than the order.
ALTER TABLE public.qb_customer
  ADD COLUMN IF NOT EXISTS data_ext jsonb;
