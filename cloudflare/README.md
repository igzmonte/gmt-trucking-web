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

## Staged live-use checklist

This Cloudflare app is ready for controlled, real-user testing with sanitized or
test data after the deployment checklist has been completed. An Admin can open
`/data-tools/checklist` to see configuration blockers, relationship warnings,
backup reminders, and the required workflow smoke test.

Before inviting staff:

1. Set a unique long `GMT_SESSION_SECRET` in Cloudflare's encrypted environment
   settings; do not rely on the placeholder value in `wrangler.toml`.
2. Sign in as Admin, complete Settings, download `/data-tools/export.json`, and
   review `/data-tools/checklist`.
3. Create separate role accounts and complete the staged workflow test in
   [`docs/STAGED_LIVE_USE.md`](docs/STAGED_LIVE_USE.md).

The readiness checklist does not import or clear data. Production data cutover
is a separate, manually approved operation: export Django/SQLite SQL and its
manifest, apply it to a fresh or explicitly prepared D1 database, then compare
Data Tools counts/control totals with the manifest before allowing live entry.

## Current implementation status

The Cloudflare app now includes authentication/RBAC, master data, recurring
trips, trips, maintenance, advances, payroll, billing, collections, SOA,
reports, user management, settings, Data Tools, and printable documents.
Django remains the parity reference until a dedicated production-cutover
rehearsal proves the imported data and outputs match.
