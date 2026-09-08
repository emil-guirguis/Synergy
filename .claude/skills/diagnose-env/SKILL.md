---
name: diagnose-env
description: Use when debugging env/secret conflicts — checks root .env, frontend .env, .dev.vars, launch.json overrides, and Cloudflare Worker secrets before assuming a code bug.
---

# diagnose-env

When debugging env/secret issues:
1. Check root .env, frontend/.env, and .dev.vars for conflicts
2. Check VS Code launch.json for overrides
3. For Cloudflare: run `wrangler secret list` to verify production secrets
4. Test the secret directly with curl before assuming code bug
5. Report all conflicting values found before changing anything
