-- aichat:sql gates the AI chat run_sql_query tool (arbitrary read-only SELECT
-- across the whole schema) specifically — see permissions.ts's comment on the
-- permission and routes/aiChat.ts's rewritten executeTool gating. Admin only,
-- same pattern as migrations/042-role-admin-grants.sql.
INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields)
SELECT r.role_id, 'aichat:sql', 'all', ARRAY[]::text[]
  FROM public.role r
 WHERE r.tenant_id IS NULL AND r.code = 'admin'
ON CONFLICT (role_id, permission) DO NOTHING;
