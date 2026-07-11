from decimal import Decimal

from django.db.models import Sum


def _parts(*values):
    return " — ".join(str(value).strip() for value in values if str(value or "").strip())


def employee_label(employee):
    return _parts(employee.employee_code, employee.full_name, employee.employee_type, employee.payroll_basis)


def asset_label(asset):
    return _parts(asset.asset_code, asset.plate_no, asset.asset_type, asset.make_model)


def client_label(client):
    return _parts(client.client_code, client.client_name)


def supplier_label(supplier):
    return _parts(supplier.supplier_name, supplier.contact_person)


def recurring_trip_label(master):
    route = " → ".join(part for part in (master.origin, master.destination) if part)
    client = client_label(master.client) if master.client_id else ""
    return _parts(master.master_code or f"Recurring Master {master.pk}", client, route, master.job_description)


def billing_label(statement):
    collections = statement.collections.aggregate(total=Sum("amount_paid"))["total"] or Decimal("0")
    balance = Decimal(statement.grand_total or 0) - Decimal(collections)
    return _parts(
        statement.billing_no,
        client_label(statement.client),
        statement.billing_date,
        f"Balance ₱ {balance:,.2f}",
        statement.status,
    )


def choice_label(obj):
    if obj is None:
        return ""
    name = obj.__class__.__name__
    if name == "Employee":
        return employee_label(obj)
    if name == "Asset":
        return asset_label(obj)
    if name == "Client":
        return client_label(obj)
    if name == "Supplier":
        return supplier_label(obj)
    if name == "RecurringTripMaster":
        return recurring_trip_label(obj)
    if name == "BillingStatement":
        return billing_label(obj)
    return str(obj)


def apply_choice_labels(*fields):
    for field in fields:
        field.label_from_instance = choice_label
