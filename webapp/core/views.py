from django.shortcuts import render
from .access import page_access
from .services import dashboard_snapshot

@page_access("Dashboard")
def dashboard(request):
    return render(request, "core/dashboard.html", dashboard_snapshot() | {"page_title": "Dashboard"})

@page_access("Reports")
def reports_placeholder(request):
    return render(request, "core/placeholder.html", {"page_title": "Reports", "message": "Reports migrate in Phase 8; access control is active now."})
