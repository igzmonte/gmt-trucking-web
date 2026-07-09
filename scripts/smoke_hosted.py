"""Read-only HTTPS smoke checks for a deployed GMT preview."""
from __future__ import annotations

import os
import re
import sys
from http.cookiejar import CookieJar
from urllib.error import HTTPError
from urllib.parse import urlencode, urljoin
from urllib.request import HTTPCookieProcessor, Request, build_opener


CSRF_RE = re.compile(r'name="csrfmiddlewaretoken" value="([^"]+)"')


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


class Session:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/") + "/"
        self.opener = build_opener(HTTPCookieProcessor(CookieJar()))
        self.csrf = ""

    def request(self, path: str, data: dict[str, str] | None = None) -> tuple[int, str]:
        url = urljoin(self.base_url, path.lstrip("/"))
        encoded = urlencode(data).encode() if data is not None else None
        headers = {"User-Agent": "GMT-hosted-smoke/1.0"}
        if encoded is not None and self.csrf:
            headers["X-CSRFToken"] = self.csrf
            headers["Referer"] = url
        request = Request(url, data=encoded, headers=headers)
        try:
            response = self.opener.open(request, timeout=30)
            body = response.read().decode("utf-8", errors="replace")
            status = response.status
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            status = exc.code
        match = CSRF_RE.search(body)
        if match:
            self.csrf = match.group(1)
        return status, body

    def login(self, username: str, password: str) -> None:
        status, _ = self.request("/login/")
        assert status == 200 and self.csrf, f"Login form unavailable for {username}: HTTP {status}"
        status, body = self.request(
            "/login/",
            {"username": username, "password": password, "csrfmiddlewaretoken": self.csrf},
        )
        assert status == 200 and "Sign out" in body, f"Login failed for {username}: HTTP {status}"


def main() -> int:
    base_url = required("GMT_SMOKE_BASE_URL")
    if not base_url.startswith("https://"):
        raise RuntimeError("GMT_SMOKE_BASE_URL must use HTTPS")
    admin_username = required("GMT_SMOKE_ADMIN_USERNAME")
    admin_password = required("GMT_SMOKE_ADMIN_PASSWORD")
    preview_password = required("GMT_SMOKE_PREVIEW_ROLE_PASSWORD")

    public = Session(base_url)
    status, body = public.request("/health/")
    assert status == 200 and '"status": "ok"' in body, f"Health check failed: HTTP {status}"

    admin = Session(base_url)
    admin.login(admin_username, admin_password)
    for path in ("/", "/employees/", "/fleet/", "/clients/", "/suppliers/"):
        status, _ = admin.request(path)
        assert status == 200, f"Admin path failed: {path} returned HTTP {status}"

    encoder = Session(base_url)
    encoder.login("preview_encoder", preview_password)
    assert encoder.request("/clients/new/")[0] == 200, "Encoder cannot open client create form"

    viewer = Session(base_url)
    viewer.login("preview_viewer", preview_password)
    assert viewer.request("/employees/")[0] == 200, "Viewer cannot read Employees"
    assert viewer.request("/clients/new/")[0] == 403, "Viewer unexpectedly reached a mutation form"

    accounting = Session(base_url)
    accounting.login("preview_accounting", preview_password)
    assert accounting.request("/")[0] == 200, "Accounting cannot open dashboard"
    assert accounting.request("/employees/")[0] == 403, "Accounting unexpectedly reached master data"

    print("Hosted HTTPS health, login, dashboard, modules, and RBAC checks passed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, RuntimeError) as exc:
        print(f"Smoke check failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
