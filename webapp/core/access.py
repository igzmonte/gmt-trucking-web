from functools import wraps
from django.contrib.auth.views import redirect_to_login
from django.core.exceptions import PermissionDenied

ROLE_PAGE_ACCESS = {
    "admin": {"Dashboard", "Trips", "Recurring Trips", "Employees", "Fleet / Equipment", "Clients", "Suppliers", "Repairs", "Vale / Cash Advance", "Payroll", "Billing", "Collections", "Payables", "Reports", "Settings", "User Management"},
    "encoder": {"Dashboard", "Trips", "Recurring Trips", "Employees", "Fleet / Equipment", "Clients", "Suppliers", "Repairs", "Vale / Cash Advance"},
    "viewer": {"Dashboard", "Trips", "Recurring Trips", "Employees", "Fleet / Equipment", "Clients", "Suppliers", "Repairs", "Vale / Cash Advance", "Payroll", "Billing", "Collections", "Payables", "Reports"},
    "accounting": {"Dashboard", "Payroll", "Billing", "Collections", "Payables", "Reports"},
}
ROLE_EDIT_ACCESS = {
    "admin": "*",
    "encoder": {"Trips", "Recurring Trips", "Employees", "Fleet / Equipment", "Clients", "Suppliers", "Repairs", "Vale / Cash Advance"},
    "viewer": set(),
    "accounting": {"Payroll", "Billing", "Collections", "Payables"},
}

def user_role(user):
    if user.is_superuser:
        return "admin"
    return user.groups.order_by("name").values_list("name", flat=True).first() or ""

def can_view(user, page):
    return user.is_authenticated and page in ROLE_PAGE_ACCESS.get(user_role(user), set())

def can_edit(user, page):
    allowed = ROLE_EDIT_ACCESS.get(user_role(user), set())
    return user.is_authenticated and (allowed == "*" or page in allowed)

def page_access(page):
    def decorator(view):
        @wraps(view)
        def wrapped(request, *args, **kwargs):
            if not request.user.is_authenticated:
                return redirect_to_login(request.get_full_path())
            if not can_view(request.user, page):
                raise PermissionDenied
            return view(request, *args, **kwargs)
        return wrapped
    return decorator
