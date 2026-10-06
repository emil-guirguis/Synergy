-- Grants reps the AI chat quote wizard (create a quote, dictate line items)
-- without giving them the rest of AI chat's tool set. Migration 040
-- deliberately left aichat:use off the rep role because every tool at the
-- time was unscoped (any rep's orders/invoices, run_sql_query over anything).
-- 'own' scope here is a signal routes/aiChat.ts reads to swap in a narrow
-- tool set (search_customers/search_catalog/create_quote/add_quote_line/
-- get_quote, all forced to the caller's own sales_rep_list_id) instead of
-- the full admin set — it is not used for row-filtering a query the way
-- quote:read's 'own' scope is.
INSERT INTO public.role_permission (role_id, permission, scope)
SELECT r.role_id, 'aichat:use', 'own'
  FROM public.role r
 WHERE r.tenant_id IS NULL AND r.code IN ('rep', 'customer');
