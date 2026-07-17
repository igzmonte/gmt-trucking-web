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
python cloudflare/tools/export_django_sqlite_to_d1.py webapp/dev.sqlite3 > cloudflare/import.sql
npx wrangler d1 execute gmt-trucking --file=./import.sql
```

The exporter skips Django auth users. Create real Cloudflare preview users separately.

## Data Tools backup and guided import

After deployment, Admin users can open `/data-tools` to download a JSON backup,
review D1 row counts, financial control totals, and relationship warnings.
Password hashes are excluded from JSON backups.

For large imports, use Wrangler instead of browser upload so Cloudflare free-tier
request limits do not interrupt the import:

```bash
cd cloudflare
python tools/export_django_sqlite_to_d1.py ../webapp/dev.sqlite3 > import.sql
npx wrangler d1 execute gmt-trucking --remote --file=./import.sql
```

Then reopen `/data-tools` and compare row counts, control totals, and warnings.

## Current implementation status

This is Phase 1 of the rewrite: foundation, schema, auth, layout, dashboard, master data shell, trip shell, report shell, and parity service tests. Django remains the source of truth until every workflow is ported and verified.
