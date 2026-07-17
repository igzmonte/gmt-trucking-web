# GMT Cloudflare Rewrite

Cloudflare-native rewrite target for the GMT Trucking web app.

This app is intentionally kept beside the Django app until parity is proven.

## Stack

- Cloudflare Pages for static assets
- Cloudflare Pages Functions / Workers runtime for server logic
- Cloudflare D1 for the relational SQLite-like database
- Plain ES modules and small server-rendered HTML helpers to avoid paid build/runtime dependencies

## Local setup

```bash
cd cloudflare
npm install
npm test
```

For Cloudflare development, install/use Wrangler:

```bash
npm run dev
```

## Cloudflare setup

1. Create a D1 database named `gmt-trucking`.
2. Put its database id in `wrangler.toml`.
3. Apply schema:

```bash
npx wrangler d1 execute gmt-trucking --file=./migrations/0001_initial.sql
```

4. Seed preview data:

```bash
npx wrangler d1 execute gmt-trucking --file=./migrations/0002_seed_preview.sql
```

Preview login:

```text
Username: test_admin
Password: characterization-only
```

## Export Django SQLite data for D1

```bash
cd cloudflare
python tools/export_django_sqlite_to_d1.py ../webapp/dev.sqlite3 --output-sql import.sql --summary-json import-manifest.json
npx wrangler d1 execute gmt-trucking --file=./import.sql
```

For validation without writing SQL:

```bash
cd cloudflare
python tools/export_django_sqlite_to_d1.py ../webapp/dev.sqlite3 --dry-run --summary-json import-manifest.json
```

The exporter skips Django auth users by default and records that choice in the
manifest. Create or reset real Cloudflare users through User Management. The
`--include-users` option exists only for non-production/testing with a compatible
Cloudflare `users` table.

## Data Tools backup and guided import

After deployment, Admin users can open `/data-tools` to download a JSON backup,
review D1 row counts, financial control totals, and relationship warnings.
Password hashes are excluded from JSON backups.

For large imports, use Wrangler instead of browser upload so Cloudflare free-tier
request limits do not interrupt the import:

```bash
cd cloudflare
# First download /data-tools/export.json and save it as your D1 backup.
python tools/export_django_sqlite_to_d1.py ../webapp/dev.sqlite3 --output-sql import.sql --summary-json import-manifest.json
npx wrangler d1 execute gmt-trucking --remote --file=./import.sql
```

Then reopen `/data-tools` and compare row counts, control totals, and warnings
against `import-manifest.json`. For production cutover, use a fresh D1 database
or manually confirm a safe cleanup before importing; this project intentionally
does not run destructive replace/wipe SQL from the browser.

## Current implementation status

This is Phase 1 of the rewrite: foundation, schema, auth, layout, dashboard, master data shell, trip shell, report shell, and parity service tests. Django remains the source of truth until every workflow is ported and verified.
