from collections import OrderedDict
from datetime import date
from decimal import Decimal

from django.db.models import Prefetch, Q, Sum

from .billing_services import outstanding_balance
from .models import (
    Asset, BillingStatement, CashAdvance, Payable, PayrollEntry, Repair, Trip,
    ValeRecord,
)


REPORTS = OrderedDict((slug, label) for slug, label in (
    ("this_month_trips", "This Month's Trips"),
    ("ongoing_trips", "Ongoing Trips"),
    ("completed_trips", "Completed Trips"),
    ("unbilled_trips", "Unbilled Trips"),
    ("billing_summary", "Billing Summary"),
    ("receivables_summary", "Receivables Summary"),
    ("payables_summary", "Payables Summary"),
    ("vale_balance", "Vale Balance Report"),
    ("cash_advance_balance", "Cash Advance Balance Report"),
    ("payroll_summary", "Payroll Summary"),
    ("repair_summary", "Repair / Maintenance Summary"),
    ("fleet_utilization", "Fleet Utilization"),
))


def _month_bounds(value):
    start = value.replace(day=1)
    end = date(start.year + (start.month == 12), 1 if start.month == 12 else start.month + 1, 1)
    return start, end


def _date_filter(queryset, field, date_from, date_to):
    if date_from:
        queryset = queryset.filter(**{f"{field}__gte": date_from})
    if date_to:
        queryset = queryset.filter(**{f"{field}__lte": date_to})
    return queryset


def _trip_filter(queryset, query, date_from, date_to, status=None):
    queryset = _date_filter(queryset, "trip_date", date_from, date_to)
    if query:
        queryset = queryset.filter(
            Q(trip_ticket_no__icontains=query) | Q(reference_no__icontains=query)
            | Q(client__client_name__icontains=query) | Q(origin__icontains=query)
            | Q(destination__icontains=query)
        )
    if status:
        queryset = queryset.filter(status=status)
    return queryset


def _result(slug, columns, rows, description):
    totals = []
    for index, (_, kind) in enumerate(columns):
        if kind in {"money", "number"}:
            value = sum((Decimal(row[index] or 0) for row in rows), Decimal("0"))
        else:
            value = "Totals" if index == 0 else ""
        totals.append({"value": value, "kind": kind})
    return {
        "slug": slug, "label": REPORTS[slug], "description": description,
        "columns": [{"label": label, "kind": kind} for label, kind in columns],
        "raw_rows": rows,
        "rows": [[{"value": value, "kind": columns[index][1]} for index, value in enumerate(row)] for row in rows],
        "totals": totals, "row_count": len(rows),
    }


def build_report(slug, *, query="", date_from=None, date_to=None, status=""):
    query = (query or "").strip()
    if slug == "this_month_trips":
        if not date_from and not date_to:
            date_from, exclusive_end = _month_bounds(date.today())
            queryset = Trip.objects.filter(trip_date__gte=date_from, trip_date__lt=exclusive_end)
            queryset = _trip_filter(queryset, query, None, None, status)
        else:
            queryset = _trip_filter(Trip.objects.all(), query, date_from, date_to, status)
        rows = [(row.trip_ticket_no, row.trip_date, row.status, row.base_trip_rate) for row in queryset.order_by("trip_date", "id")]
        return _result(slug, (("Trip Ticket / Waybill", "text"), ("Date", "date"), ("Status", "text"), ("Base Rate", "money")), rows, "Trips within the current month, or the selected date range.")

    if slug in {"ongoing_trips", "completed_trips", "unbilled_trips"}:
        queryset = Trip.objects.select_related("client")
        fixed_status = Trip.Status.ONGOING if slug == "ongoing_trips" else Trip.Status.COMPLETED
        queryset = _trip_filter(queryset, query, date_from, date_to, status or fixed_status)
        if slug == "unbilled_trips":
            queryset = queryset.filter(billing_line__isnull=True)
        queryset = queryset.order_by("-trip_date", "id")
        if slug == "ongoing_trips":
            rows = [(row.trip_ticket_no, row.trip_date, row.client.client_name if row.client else "", f"{row.origin} -> {row.destination}") for row in queryset]
            return _result(slug, (("Trip Ticket / Waybill", "text"), ("Date", "date"), ("Client", "text"), ("Route", "text")), rows, "Trips currently marked Ongoing.")
        if slug == "completed_trips":
            rows = [(row.trip_ticket_no, row.trip_date, row.status, row.base_trip_rate) for row in queryset]
            return _result(slug, (("Trip Ticket / Waybill", "text"), ("Date", "date"), ("Status", "text"), ("Base Rate", "money")), rows, "Completed trips, including their base rates.")
        rows = [(row.trip_ticket_no, row.trip_date, row.client.client_name if row.client else "", row.base_trip_rate) for row in queryset]
        return _result(slug, (("Trip Ticket / Waybill", "text"), ("Date", "date"), ("Client", "text"), ("Base Rate", "money")), rows, "Completed trips that have not been claimed by billing.")

    if slug in {"billing_summary", "receivables_summary"}:
        queryset = _date_filter(BillingStatement.objects.select_related("client"), "billing_date", date_from, date_to)
        if query:
            queryset = queryset.filter(Q(billing_no__icontains=query) | Q(client__client_name__icontains=query))
        if status:
            queryset = queryset.filter(status=status)
        queryset = queryset.order_by("-billing_date", "id")
        if slug == "billing_summary":
            rows = [(row.billing_no, row.billing_date, row.client.client_name, row.grand_total, row.status) for row in queryset]
            return _result(slug, (("Billing No", "text"), ("Date", "date"), ("Client", "text"), ("Grand Total", "money"), ("Status", "text")), rows, "Saved billing statements and their current statuses.")
        rows = [(row.billing_no, row.client.client_name, row.grand_total, outstanding_balance(row), row.status) for row in queryset]
        return _result(slug, (("Billing No", "text"), ("Client", "text"), ("Grand Total", "money"), ("Outstanding", "money"), ("Status", "text")), rows, "Billing totals compared with remaining receivable balances.")

    if slug == "payables_summary":
        queryset = _date_filter(Payable.objects.select_related("supplier"), "payable_date", date_from, date_to)
        if query:
            queryset = queryset.filter(Q(description__icontains=query) | Q(reference_no__icontains=query) | Q(supplier__supplier_name__icontains=query))
        if status:
            queryset = queryset.filter(status=status)
        rows = [(row.payable_date, row.description, row.amount, row.due_date or "", row.status) for row in queryset.order_by("-payable_date", "id")]
        return _result(slug, (("Date", "date"), ("Description", "text"), ("Amount", "money"), ("Due Date", "date"), ("Status", "text")), rows, "Supplier obligations, due dates, and payment statuses.")

    if slug in {"vale_balance", "cash_advance_balance"}:
        model = ValeRecord if slug == "vale_balance" else CashAdvance
        queryset = _date_filter(model.objects.select_related("employee"), "date_granted", date_from, date_to)
        if query:
            queryset = queryset.filter(Q(employee__full_name__icontains=query) | Q(employee__employee_code__icontains=query) | Q(notes__icontains=query))
        if status:
            queryset = queryset.filter(status=status)
        queryset = queryset.order_by("-date_granted", "id")
        if slug == "vale_balance":
            rows = [(row.employee.full_name, row.date_granted, row.amount, row.installment_amount, row.balance, row.status) for row in queryset]
            return _result(slug, (("Employee", "text"), ("Date Granted", "date"), ("Amount", "money"), ("Installment", "money"), ("Balance", "money"), ("Status", "text")), rows, "Vale amounts, payroll installments, and remaining balances.")
        rows = [(row.employee.full_name, row.date_granted, row.amount, row.balance, row.status) for row in queryset]
        return _result(slug, (("Employee", "text"), ("Date Granted", "date"), ("Amount", "money"), ("Balance", "money"), ("Status", "text")), rows, "Cash advances and their remaining payroll balances.")

    if slug == "payroll_summary":
        queryset = _date_filter(PayrollEntry.objects.select_related("employee"), "pay_date", date_from, date_to)
        if query:
            queryset = queryset.filter(Q(employee__full_name__icontains=query) | Q(employee__employee_code__icontains=query) | Q(employee_type__icontains=query))
        rows = [(row.pay_date, row.employee.full_name, row.employee_type, row.gross_pay, row.additional_pay, row.net_pay) for row in queryset.order_by("-pay_date", "id")]
        return _result(slug, (("Pay Date", "date"), ("Employee", "text"), ("Type", "text"), ("Gross Pay", "money"), ("Additional Pay", "money"), ("Net Pay", "money")), rows, "Saved employee payroll totals.")

    if slug == "repair_summary":
        queryset = _date_filter(Repair.objects.select_related("asset", "supplier"), "repair_date", date_from, date_to)
        if query:
            queryset = queryset.filter(Q(asset__asset_code__icontains=query) | Q(repair_description__icontains=query) | Q(supplier__supplier_name__icontains=query))
        if status:
            queryset = queryset.filter(status=status)
        rows = [(row.repair_date, row.asset.asset_code if row.asset else "", row.repair_description, row.total_cost, row.status) for row in queryset.order_by("-repair_date", "id")]
        return _result(slug, (("Date", "date"), ("Asset", "text"), ("Description", "text"), ("Total Cost", "money"), ("Status", "text")), rows, "Repair and maintenance costs by unit.")

    trip_queryset = _date_filter(Trip.objects.all(), "trip_date", date_from, date_to)
    if status:
        trip_queryset = trip_queryset.filter(status=status)
    assets = Asset.objects.all()
    if query:
        assets = assets.filter(Q(asset_code__icontains=query) | Q(asset_type__icontains=query) | Q(plate_no__icontains=query) | Q(make_model__icontains=query))
    assets = assets.prefetch_related(Prefetch("trips", queryset=trip_queryset, to_attr="report_trips")).order_by("asset_code", "id")
    rows = []
    for asset in assets:
        trips = asset.report_trips
        rows.append((asset.asset_code, asset.asset_type, len(trips), sum((Decimal(row.base_trip_rate or 0) for row in trips), Decimal("0")), sum((Decimal(row.extra_total or 0) for row in trips), Decimal("0"))))
    return _result(slug, (("Asset", "text"), ("Type", "text"), ("Trips", "number"), ("Base Charges", "money"), ("Extra Charges", "money")), rows, "Trip volume and charges grouped by fleet unit.")
