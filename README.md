# GMT Trucking Web

This repository contains the Django migration preview for GMT Trucking. It is designed to run as one Render web service backed by managed PostgreSQL. End users open an HTTPS URL and install nothing.

## Current web features

- Secure login and logout
- Role-based access for Admin, Encoder, Viewer, and Accounting
- ORM-powered dashboard
- Employees, Fleet, Clients, and Suppliers modules
- Search, sorting, pagination, create, edit, protected delete, and CSV export
- CSRF-protected mutations
- PostgreSQL-compatible models and legacy importer
- WhiteNoise static assets with `DEBUG=false`
- Database-aware `/health/` endpoint
- GitHub CI, Render Blueprint, and hosted smoke checks

## Deployment

Follow [Hosted deployment](docs/migration/HOSTED_DEPLOYMENT.md). The main deployment files are:

- `render.yaml`
- `build.sh`
- `requirements-web.txt`
- `webapp/`

The repository intentionally excludes SQLite databases, production data, branding, secrets, local dependencies, logs, and generated output.

## Local development

`scripts/run_web.bat` is an optional local helper. It is not part of the hosted user workflow. The legacy CustomTkinter source remains in `app.py` solely for migration parity work.
