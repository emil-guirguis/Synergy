# TBWC api Worker — production deploy (interim: under MIP's Cloudflare account)

Deploys the TBWC data API + QBWC SOAP endpoint as its own Worker at
`https://tbwc-api.<your-subdomain>.workers.dev`. Frontend (GitHub Pages subpath
`/TBWCPortal/`) and the remote QuickBooks Web Connector both point at it.

Run everything from `TBWC/api/` unless noted.

## 0. Confirm the account
```
npx wrangler whoami
```
Must be the account that owns meteritpro.com (currently: emilguirguis@yahoo.com,
id cd6413ed43eb98e73fd4bb4741dafd5f). If not, `npx wrangler login` into it.

## 1. Build the in-repo framework (Worker bundles framework-backend from dist)
```
# from repo root
npm run build:framework
```

## 2. Create Hyperdrive → the TBWC Supabase pooler
Prod DB goes through Hyperdrive (db.ts uses HYPERDRIVE.connectionString when no
DATABASE_URL). TBWC uses its OWN Supabase project (ihnezwvduwimprqascsf, us-west-1 —
migrated 2026-09-29 from ca-central-1/detwkqhqekaiyuajixhs for latency to the
Vegas/Ontario-CA offices), so it needs its OWN Hyperdrive (not MIP's).
```
npx wrangler hyperdrive create tbwc-prod \
  --connection-string="postgresql://postgres.ihnezwvduwimprqascsf:h6kJwcfbGAiR8B2jjXwyLTud@aws-0-us-west-1.pooler.supabase.com:5432/postgres"
```
Copy the returned `id` → paste into `wrangler.toml` under `[[env.production.hyperdrive]]`
(replace `<<PROD_HYPERDRIVE_ID>>`).

> If the CLI lacks Hyperdrive permission, create it in the dashboard:
> Workers & Pages → Hyperdrive → Create, same connection string.

## 3. Set prod secrets (QBWC credentials — pick real values, not tbwc/changeme)
```
npx wrangler secret put QBWC_USERNAME --env production
npx wrangler secret put QBWC_PASSWORD --env production
```

Do NOT pipe the value in from PowerShell (`"pw" | wrangler secret put ...`) — the
trailing newline is stored as part of the secret and every QBWC login then fails
with `QBWC1040: ... did not provide a valid password`. Type it at the prompt, or
use `npx wrangler secret bulk secrets.json --env production` for exact bytes.

### Unattended sync (QuickBooks not running)
By default the Worker answers `authenticate` with `""` = "use the company file
already open in QuickBooks", so a run with QB closed dies with `Could not start
QuickBooks`. To let the connector start QB itself, both of these are required:

1. `QBWC_COMPANY_FILE` set to the absolute `.qbw` path as the QB machine sees it
   (`[env.production.vars]` in `wrangler.toml`).
2. In QuickBooks: Edit → Preferences → Integrated Applications → Company
   Preferences → select `TBWC QuickBooks Sync` → Properties → **allow access even
   when QuickBooks is not running**, and pick the QB login it runs as.

Step 2 is the part QB enforces; the path alone will not do it.

## 4. Deploy
```
npx wrangler deploy --env production
```
Note the deployed URL from the output: `https://tbwc-api.<subdomain>.workers.dev`.

## 5. Smoke-test the endpoints
```
curl https://tbwc-api.<subdomain>.workers.dev/api/health          # {status:OK,...}
curl "https://tbwc-api.<subdomain>.workers.dev/qbwc?wsdl"          # WSDL XML
```

## 6. Wire the URL into the two consumers
- `TBWC/frontend/.env.production` → `VITE_API_BASE_URL=https://tbwc-api.<subdomain>.workers.dev/api`
- `TBWC/api/worker/qbwc/tbwc.qwc` → `<AppURL>https://tbwc-api.<subdomain>.workers.dev/qbwc</AppURL>`
  and `<UserName>` = the QBWC_USERNAME set in step 3.

Then re-add the app in the Web Connector on the remote workstation (password =
QBWC_PASSWORD). Watch it live from here: `npx wrangler tail --env production`.

## Notes
- CORS origin (`FRONTEND_URL`) is set to `https://emil-guirguis.github.io` (the Pages
  site origin). Update if the portal moves to a custom domain.
- workers.dev gives a valid public HTTPS cert — QBWC accepts it. No DNS work needed.
- To brand the api later: add a route `meteritpro.com/tbwc-api/*` (needs the zone) and
  repoint both consumers.
