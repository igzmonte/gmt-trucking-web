from collections import OrderedDict
from decimal import Decimal, ROUND_HALF_UP

from django.db import transaction
from django.db.models import Q

from .models import (
    CashAdvance, Employee, PayrollAdditionalLine, PayrollEntry, PayrollTrip,
    Trip, ValeRecord,
)


ZERO = Decimal("0.00")
PENNY = Decimal("0.01")
ELIGIBLE_STATUSES = (Trip.Status.COMPLETED, Trip.Status.BILLED, Trip.Status.PAID)
DEDUCTION_FIELDS = (
    "vale_deduction", "cash_advance_deduction", "sss", "philhealth", "pagibig",
    "withholding_tax", "change_deduction", "other_deduction",
)


def money(value):
    return Decimal(value or 0).quantize(PENNY, rounding=ROUND_HALF_UP)


def _eligible_trips(employee, period_from, period_to):
    rows = Trip.objects.filter(
        trip_date__range=(period_from, period_to), status__in=ELIGIBLE_STATUSES,
    ).exclude(payroll_links__employee=employee)
    if employee.employee_type == Employee.Type.DRIVER:
        rows = rows.filter(driver=employee)
    elif employee.employee_type == Employee.Type.HELPER:
        rows = rows.filter(helper_assignments__employee=employee)
    else:
        return []
    return list(rows.select_related("asset").prefetch_related(
        "helper_assignments", "employee_pay_items"
    ).distinct().order_by("trip_date", "trip_ticket_no", "id"))


def _helper_share(total, trip):
    count = len(trip.helper_assignments.all())
    return ZERO if count <= 0 else Decimal(total or 0) / Decimal(count)


def _trip_base_amount(trip, employee_type):
    if employee_type == Employee.Type.DRIVER:
        return Decimal(trip.driver_pay_rate or 0)
    if employee_type == Employee.Type.HELPER:
        return _helper_share(trip.helper_pay_rate, trip)
    return ZERO


def _trip_additional_items(trip, employee_type):
    items = [item for item in trip.employee_pay_items.all() if item.employee_type == employee_type]
    if items:
        return [(item.label, Decimal(item.amount or 0)) for item in items]
    fallback = trip.driver_additional_pay if employee_type == Employee.Type.DRIVER else trip.helper_additional_pay
    label = "Driver Pay Item" if employee_type == Employee.Type.DRIVER else "Helper Pay Item"
    return [(label, Decimal(fallback or 0))] if fallback else []


def payroll_preview(employee, period_from, period_to):
    trips = _eligible_trips(employee, period_from, period_to)
    line_totals = OrderedDict()
    trip_rows = []
    gross_raw = ZERO
    for trip in trips:
        base_amount = _trip_base_amount(trip, employee.employee_type)
        gross_raw += base_amount
        trip_rows.append({"trip": trip, "amount": money(base_amount)})
        for label, raw_amount in _trip_additional_items(trip, employee.employee_type):
            amount = raw_amount if employee.employee_type == Employee.Type.DRIVER else _helper_share(raw_amount, trip)
            if amount > 0:
                line_totals[label] = line_totals.get(label, ZERO) + amount

    additional_lines = [
        {"employee_type": employee.employee_type, "label": label, "amount": money(amount), "sort_order": index}
        for index, (label, amount) in enumerate(line_totals.items(), start=1)
    ]
    additional_pay = money(sum((line["amount"] for line in additional_lines), ZERO))

    vale_plan = []
    for row in ValeRecord.objects.filter(employee=employee, status="Open").order_by("date_granted", "id"):
        balance = Decimal(row.balance or 0)
        installment = Decimal(row.installment_amount or 0) or balance
        applied = min(balance, installment)
        if applied > 0:
            vale_plan.append((row.pk, money(applied)))
    cash_plan = [
        (row.pk, money(row.balance))
        for row in CashAdvance.objects.filter(employee=employee, status="Open").order_by("date_granted", "id")
        if row.balance > 0
    ]

    if employee.employee_type == Employee.Type.DRIVER:
        unit_description = f"{len(trips)} trip(s)"
    elif employee.employee_type == Employee.Type.HELPER:
        unit_description = f"{len(trips)} helper trip(s)"
    elif employee.employee_type == Employee.Type.OPERATOR or employee.payroll_basis == Employee.PayrollBasis.PER_DAY:
        unit_description = "Enter days worked manually or override amount"
    else:
        unit_description = "Manual payroll entry"

    return {
        "employee": employee, "employee_type": employee.employee_type,
        "payroll_basis": employee.payroll_basis or Employee.PayrollBasis.MANUAL,
        "unit_description": unit_description, "trips": trips, "trip_rows": trip_rows,
        "trips_count": len(trips), "gross_pay": money(gross_raw),
        "additional_pay": additional_pay, "additional_lines": additional_lines,
        "driver_trip_additional_pay": additional_pay if employee.employee_type == Employee.Type.DRIVER else ZERO,
        "helper_trip_additional_pay": additional_pay if employee.employee_type == Employee.Type.HELPER else ZERO,
        "vale_plan": vale_plan, "cash_plan": cash_plan,
        "vale_deduction": money(sum((amount for _, amount in vale_plan), ZERO)),
        "cash_advance_deduction": money(sum((amount for _, amount in cash_plan), ZERO)),
    }


def calculate_net(gross_pay, additional_pay, deductions):
    return money(Decimal(gross_pay or 0) + Decimal(additional_pay or 0) - sum((Decimal(deductions.get(name) or 0) for name in DEDUCTION_FIELDS), ZERO))


def _apply_plan(model, plan, requested, *, cash=False):
    remaining = money(requested)
    for record_id, maximum in plan:
        if remaining <= 0:
            break
        row = model.objects.select_for_update().get(pk=record_id)
        applied = min(remaining, maximum, Decimal(row.balance or 0))
        row.balance = money(Decimal(row.balance or 0) - applied)
        row.status = "Closed" if row.balance <= 0 else "Open"
        fields = ["balance", "status"]
        if cash:
            row.applied = row.balance <= 0
            fields.append("applied")
        row.save(update_fields=fields)
        remaining -= applied
    if remaining > 0:
        raise ValueError("The requested advance deduction is greater than the available open balance.")


@transaction.atomic
def create_payroll(cleaned, preview):
    employee = Employee.objects.select_for_update().get(pk=cleaned["employee"].pk)
    fresh = payroll_preview(employee, cleaned["period_from"], cleaned["period_to"])
    expected_ids = [trip.pk for trip in preview["trips"]]
    fresh_ids = [trip.pk for trip in fresh["trips"]]
    if fresh_ids != expected_ids:
        raise ValueError("Payroll eligibility changed. Preview the period again before saving.")

    deductions = {name: money(cleaned.get(name)) for name in DEDUCTION_FIELDS}
    entry = PayrollEntry.objects.create(
        pay_date=cleaned["pay_date"], period_from=cleaned["period_from"], period_to=cleaned["period_to"],
        employee=employee, employee_type=employee.employee_type, payroll_basis=employee.payroll_basis,
        unit_description=cleaned.get("unit_description") or fresh["unit_description"],
        trips_count=len(fresh["trips"]), days_count=cleaned.get("days_count") or ZERO,
        gross_pay=money(cleaned.get("gross_pay")), additional_pay=money(cleaned.get("additional_pay")),
        driver_trip_additional_pay=fresh["driver_trip_additional_pay"],
        helper_trip_additional_pay=fresh["helper_trip_additional_pay"],
        net_pay=calculate_net(cleaned.get("gross_pay"), cleaned.get("additional_pay"), deductions),
        remarks=cleaned.get("remarks", ""), **deductions,
    )
    PayrollTrip.objects.bulk_create([
        PayrollTrip(payroll=entry, trip=trip, employee=employee) for trip in fresh["trips"]
    ])
    lines = list(fresh["additional_lines"])
    manual = money(Decimal(cleaned.get("additional_pay") or 0) - fresh["additional_pay"])
    if manual:
        lines.append({"employee_type": "Manual", "label": "Manual Additional Pay", "amount": manual, "sort_order": len(lines) + 1})
    PayrollAdditionalLine.objects.bulk_create([PayrollAdditionalLine(payroll=entry, **line) for line in lines if line["amount"]])
    _apply_plan(ValeRecord, fresh["vale_plan"], deductions["vale_deduction"])
    _apply_plan(CashAdvance, fresh["cash_plan"], deductions["cash_advance_deduction"], cash=True)
    return entry


def _restore(model, employee, amount, *, cash=False):
    remaining = money(amount)
    rows = model.objects.select_for_update().filter(employee=employee).order_by("-date_granted", "-id")
    for row in rows:
        if remaining <= 0:
            break
        room = max(ZERO, Decimal(row.amount or 0) - Decimal(row.balance or 0))
        restored = min(room, remaining)
        if restored <= 0:
            continue
        row.balance = money(Decimal(row.balance or 0) + restored)
        row.status = "Open"
        fields = ["balance", "status"]
        if cash:
            row.applied = False
            fields.append("applied")
        row.save(update_fields=fields)
        remaining -= restored
    return money(remaining)


@transaction.atomic
def delete_payroll(entry):
    entry = PayrollEntry.objects.select_for_update().select_related("employee").get(pk=entry.pk)
    vale_unrestored = _restore(ValeRecord, entry.employee, entry.vale_deduction)
    cash_unrestored = _restore(CashAdvance, entry.employee, entry.cash_advance_deduction, cash=True)
    entry.delete()
    return vale_unrestored, cash_unrestored
