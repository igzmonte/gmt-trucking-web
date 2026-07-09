# GMT Web Migration

Phase 2 provides the responsive shell, authentication/RBAC, normalized ORM
schema, atomic legacy importer, ORM dashboard, and editable Employees, Fleet,
Clients, and Suppliers modules.

```powershell
python -m pip install -r requirements-web.txt
cd webapp
python manage.py migrate
python manage.py import_legacy --source ..\tests\characterization\artifacts\gmt_characterization.sqlite3 --dry-run
python manage.py import_legacy --source ..\tests\characterization\artifacts\gmt_characterization.sqlite3 --replace
python manage.py runserver
```

Open `http://127.0.0.1:8000/` and sign in with `test_admin` /
`characterization-only`. The web app does not access the production database.
The development authentication database defaults to the operating-system temp
folder; set `GMT_WEB_DB` to choose another writable location.

On Windows, double-click `scripts/run_web.bat` and keep its console window open.
The launcher creates a user-owned virtual environment under
`%LOCALAPPDATA%\GMTWeb\venv`; it does not use Codex's sandbox-owned `.web-deps`.
Dependencies install once on first launch. Later launches only apply pending
database migrations and start the local server.
