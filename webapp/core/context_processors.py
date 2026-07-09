from .access import ROLE_PAGE_ACCESS, can_edit, user_role

NAV_GROUPS = [
    ("Overview", ["Dashboard"]),
    ("Operations", ["Trips", "Recurring Trips", "Vale / Cash Advance"]),
    ("Maintenance", ["Repairs"]),
    ("Master Data", ["Employees", "Fleet / Equipment", "Clients", "Suppliers"]),
    ("Finance", ["Payroll", "Billing", "Collections", "Payables", "Reports"]),
    ("System", ["Settings", "User Management"]),
]

def navigation(request):
    role = user_role(request.user) if request.user.is_authenticated else ""
    allowed = ROLE_PAGE_ACCESS.get(role, set())
    route_names = {"Dashboard": "dashboard", "Trips": "trips_list", "Recurring Trips": "recurring_trips_list", "Repairs": "repairs_list", "Vale / Cash Advance": "advances_list", "Employees": "employees_list", "Fleet / Equipment": "fleet_list", "Clients": "clients_list", "Suppliers": "suppliers_list", "Payroll": "payroll_list", "Billing": "billing_list", "Collections": "collections_list", "Payables": "payables_list", "Reports": "reports", "User Management": "users_list"}
    groups = []
    for group, pages in NAV_GROUPS:
        items = []
        for page in pages:
            if page not in allowed:
                continue
            items.append({"label": "Trips List" if page == "Trips" else page, "url_name": route_names.get(page)})
            if page == "Trips" and can_edit(request.user, "Trips"):
                items.append({"label": "New Trip Details", "url_name": "trips_new", "is_subitem": True})
            if page == "Repairs" and can_edit(request.user, "Repairs"):
                items.append({"label": "New Repair Details", "url_name": "repairs_new", "is_subitem": True})
            if page == "Payables" and can_edit(request.user, "Payables"):
                items.append({"label": "New Payable Details", "url_name": "payables_new", "is_subitem": True})
            if page == "Vale / Cash Advance" and can_edit(request.user, "Vale / Cash Advance"):
                items.append({"label": "New Vale", "url_name": "vale_new", "is_subitem": True})
                items.append({"label": "New Cash Advance", "url_name": "cash_advance_new", "is_subitem": True})
            if page == "Payroll" and can_edit(request.user, "Payroll"):
                items.append({"label": "New Payroll", "url_name": "payroll_new", "is_subitem": True})
            if page == "Billing" and can_edit(request.user, "Billing"):
                items.append({"label": "New Billing Statement", "url_name": "billing_new", "is_subitem": True})
                items.append({"label": "Statement of Account", "url_name": "billing_soa", "is_subitem": True})
            if page == "Collections" and can_edit(request.user, "Collections"):
                items.append({"label": "New Collection", "url_name": "collection_new", "is_subitem": True})
        groups.append((group, items))
    return {"current_role": role, "navigation_groups": [(g, p) for g, p in groups if p]}
