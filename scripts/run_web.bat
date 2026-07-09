@echo off
setlocal
cd /d "%~dp0.."

set "GMT_ROOT=%CD%"
set "GMT_VENV=%LOCALAPPDATA%\GMTWeb\venv"
set "GMT_DEPS_MARKER=%GMT_VENV%\.gmt-web-dependencies-v1"
if not defined GMT_ADMIN_USERNAME set "GMT_ADMIN_USERNAME=local_admin"
if not defined GMT_ADMIN_PASSWORD set "GMT_ADMIN_PASSWORD=local-preview-only"
if not defined GMT_ADMIN_EMAIL set "GMT_ADMIN_EMAIL=admin@example.invalid"
if not defined GMT_PREVIEW_ROLE_PASSWORD set "GMT_PREVIEW_ROLE_PASSWORD=local-roles-only"

if not exist "%GMT_VENV%\Scripts\python.exe" (
    echo Creating your GMT Web Python environment...
    if not exist "%LOCALAPPDATA%\GMTWeb" mkdir "%LOCALAPPDATA%\GMTWeb"
    python -m venv "%GMT_VENV%"
    if errorlevel 1 goto :error
)

if not exist "%GMT_DEPS_MARKER%" (
    echo Installing GMT Web dependencies for the first run...
    "%GMT_VENV%\Scripts\python.exe" -m pip install --disable-pip-version-check -r "%GMT_ROOT%\requirements-web.txt"
    if errorlevel 1 goto :error
    echo installed>"%GMT_DEPS_MARKER%"
)

cd /d "%GMT_ROOT%\webapp"
echo Applying database migrations...
"%GMT_VENV%\Scripts\python.exe" manage.py migrate --noinput
if errorlevel 1 goto :error

echo Creating local preview accounts and synthetic data...
"%GMT_VENV%\Scripts\python.exe" manage.py bootstrap_hosted
if errorlevel 1 goto :error
"%GMT_VENV%\Scripts\python.exe" manage.py seed_hosted_preview
if errorlevel 1 goto :error

echo.
echo GMT Web is starting at http://127.0.0.1:8000/
echo Keep this window open while using the web app.
echo Press Ctrl+C to stop the server.
echo.
"%GMT_VENV%\Scripts\python.exe" manage.py runserver 127.0.0.1:8000 --noreload
goto :end

:error
echo.
echo GMT Web could not start. Review the error above.
pause

:end
endlocal
