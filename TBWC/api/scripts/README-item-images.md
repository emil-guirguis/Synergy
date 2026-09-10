# Catalog thumbnails (`qb_item.image_url`)

Product pictures for the printed price sheet, sourced by an automated web-image
sweep and then reviewed by a person.

- Schema: `migrations/027-inventory-images.sql`
- Rules: `scripts/image-families.cjs` (edit this — it's the accuracy knob)
- Sweep: `scripts/fetch-item-images.cjs`
- Review UI: Inventory list (thumbnail column) → open a row → **Image** tab (last)

## Why it works the way it does

`qb_item` has 1241 rows, **no UPC codes and no categories**, so there is no
barcode→image API path. The names are mostly private-label SKUs
(`DI-4W/200-N1-KIT.xx`), which no image search can resolve.

Two facts make the job tractable anyway:

1. **735 rows collapse into ~30 families.** 429 of them are `DI-*` meter kits —
   the same physical product in four enclosures, differing only by amperage.
   One correct photo per family beats 429 individual wrong guesses, and costs
   one search instead of 429.
2. **`sales_desc` is the searchable field, not `name`.** "PAR30 2700k FLOOD" and
   "1\" WATER METER W/ PULSE OUTPUT" are real queries; the SKU beside them is not.

Everything the sweep picks is written as `image_status = 'auto'` with a
confidence score. **Nothing reaches a printout as approved without a human**, and
re-running never overwrites a human verdict.

## One-time setup

### 1. Apply the migration

```bash
node scripts/apply-migration.cjs migrations/027-inventory-images.sql
```

Adds the `image_*` columns, the `qb_item_image_status_idx` index, and the public
`item-images` Storage bucket. Already applied to the live DB on 2026-09-09.

### 2. Secrets in `TBWC/api/.dev.vars` (never commit these)

```
SUPABASE_SERVICE_ROLE_KEY=<Supabase dashboard → Project Settings → API → service_role>
GOOGLE_CSE_KEY=<Google Cloud console → Custom Search API → credentials>
GOOGLE_CSE_CX=<programmablesearchengine.google.com → your engine's ID>
```

The Google engine must have **Image search: ON** and **Search the entire web:
ON**. An engine left in its default site-restricted mode returns zero results
for every query, which looks exactly like a broken key.

Brave works as an alternative — set `BRAVE_SEARCH_KEY` and pass
`--provider brave`.

**Cost:** ~450 API calls for the whole catalog (735 rows ride on ~30 family
searches). Google Custom Search is free to 100/day, then $5 per 1000 — so a full
sweep is roughly **$2**.

## Running it

```bash
# See the plan. No network calls, no writes. Start here.
node scripts/fetch-item-images.cjs --dry-run

# The cheap, most accurate 60% — families only, ~30 searches.
node scripts/fetch-item-images.cjs --families-only

# A taste test before committing to the long tail.
node scripts/fetch-item-images.cjs --search-only --limit 25

# Everything.
node scripts/fetch-item-images.cjs
```

Useful flags:

| Flag | Effect |
| --- | --- |
| `--dry-run` | Print the plan and sample queries; touch nothing |
| `--families-only` / `--search-only` | Run one half of the job |
| `--only '<regex>'` | Restrict to matching item names |
| `--limit N` | Stop after N rows |
| `--refresh` | Redo rows that already have an image (still skips human verdicts) |
| `--size N` | Max thumbnail edge in px, default 400 (~1.3in at 300dpi) |
| `--concurrency N` | Parallel per-SKU rows, default 3 |
| `--provider google\|brave` | Search backend |

Safe to re-run and safe to interrupt: the work set is "rows with no image that a
human hasn't ruled on", so a second run picks up where the first stopped.

## Reviewing

Open **Inventory**. The first column is the thumbnail and the `Image` column
shows `unreviewed (72%)` for anything machine-picked — scan down the list against
the descriptions, then open the bad ones.

In a record's **Image** tab an admin can:

- **Approve** — locks it in; the sweep will never touch it again.
- **Reject** — clears the picture and stops it being retried.
- **No image needed** — for line items that have no product.
- **Replace with image URL** — paste the right picture and approve in one step.

Use the **Image Status** filter set to `auto` to see only what still needs a
verdict; the percentage beside it is the match confidence, and anything under
about 60% is usually wrong.

### Known limitation

A pasted replacement URL is stored as-is — it is **not** downloaded into the
`item-images` bucket, so it hotlinks the origin and will break if that site moves
the file. Fine for a handful of manual fixes; if it becomes the norm, add a
download-and-rehost step to the PATCH route.

## Tuning accuracy

Editing `scripts/image-families.cjs` is the highest-leverage thing you can do.

- A family keeps matching badly → set `imageUrl` on the rule to a picture you
  trust. That skips search entirely for every row in the family.
- Rows getting the wrong family → rules are **first match wins**, ordered
  most-specific first. Move the rule up, or narrow the one catching it.
- A cluster falling through to per-SKU search → add a rule for it.

Then re-run just that slice:

```bash
node scripts/fetch-item-images.cjs --refresh --only '^CT'
```

`scripts/image-families.test.mjs` pins the tricky orderings (chiefly: every DI
kit description mentions a split-core CT, and must still match a DI rule). Run
`npm test` after editing the rules.

## Print pipeline

Read `image_url` directly — it's a public bucket URL, no signing needed. Filter
on `image_status` to choose your tolerance:

```sql
-- Conservative: only what a person has confirmed.
SELECT name, sales_desc, sales_price, image_url
  FROM qb_item
 WHERE is_active AND image_status = 'approved';

-- Permissive: anything with a picture, reviewed or not.
 WHERE is_active AND image_url IS NOT NULL AND image_status <> 'rejected'
```
