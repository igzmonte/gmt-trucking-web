# Hosted deployment

The web application deploys as one Django service backed by Render PostgreSQL. End users only open the HTTPS URL; they do not run `run_web.bat`, install Python, or connect to PostgreSQL.

## First deployment

1. Push this source-only repository to a private GitHub repository.
2. In Render, choose **New > Blueprint**, connect the repository, and apply `render.yaml`.
3. When prompted, enter `GMT_ADMIN_USERNAME`, `GMT_ADMIN_PASSWORD`, `GMT_ADMIN_EMAIL`, and `GMT_PREVIEW_ROLE_PASSWORD`. Use unique passwords of at least 12 characters.
4. Wait for the build and one-time initialization hook to complete.
5. Open `/health/`, then sign in at `/login/` with the administrator credentials.

The first deployment creates the four role groups, one secret-backed account per role, and deterministic synthetic preview records. The non-admin usernames are `preview_encoder`, `preview_viewer`, and `preview_accounting`. It does not import legacy users, password hashes, production data, or SQLite files.

## Deployment behavior

- GitHub commits automatically trigger Render builds.
- The build installs dependency ranges, runs Django checks, collects static files, and applies migrations.
- WhiteNoise serves versioned static files while `DEBUG=false`.
- `DATABASE_URL` comes from the database's internal connection string.
- The database has no public IP allowlist in the Blueprint.
- `/health/` returns HTTP 200 only when Django can query the database.

## Preview-tier warning

`render.yaml` selects Render's free web and PostgreSQL plans for the initial preview. As of July 2026, free PostgreSQL expires after 30 days and has no backups, while a free web service sleeps after 15 minutes of inactivity. Upgrade the database before storing operational data. Do not treat the free preview as production.

## Importing sanitized legacy data

The importer can explicitly omit all legacy credentials:

```bash
python webapp/manage.py import_legacy --source /secure/path/sanitized.sqlite3 --skip-users
```

The SQLite input must remain outside GitHub. Run this only from an authorized environment that can reach PostgreSQL. The normal hosted preview uses generated synthetic data instead.

## Required verification

- `/health/` returns 200 over HTTPS.
- Login/logout and CSRF-protected mutations work.
- Admin and Encoder can edit master data; Viewer is read-only; Accounting receives 403.
- Dashboard and all four master modules read PostgreSQL data.
- Changes survive a redeploy.
- Static CSS is served with `DEBUG=false`.
- Build logs contain no password, database URL, SQLite data, or production identifiers.

After deployment, set the smoke-test environment variables locally and run:

```bash
python scripts/smoke_hosted.py
```

The script performs read-only HTTPS checks for health, login, dashboard, all four master modules, and the four-role access boundaries. It never prints credentials.
