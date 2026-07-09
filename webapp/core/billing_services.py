from decimal import Decimal, ROUND_HALF_UP

from django.db import transaction
from django.db.models import Sum

from .models import BillingAdjustment, BillingLine, BillingStatement, Collection, Trip


ZERO = Decimal("0.00")
PENNY = Decimal("0.01")


def money(value):
    return Decimal(value or 0).quantize(PENNY, rounding=ROUND_HALF_UP)


def next_billing_no(billing_date):
    prefix = f"BS-{billing_date.year}-"
    maximum = 0
    for value in BillingStatement.objects.filter(billing_no__startswith=prefix).values_list("billing_no", flat=True):
        try:
            maximum = max(maximum, int(value.rsplit("-", 1)[1]))
        except (TypeError, ValueError, IndexError):
            continue
    return f"{prefix}{maximum + 1:06d}"


def eligible_billing_trips(client, period_from, period_to):
    return list(Trip.objects.filter(
        client=client, trip_date__range=(period_from, period_to),
        status=Trip.Status.COMPLETED, billing_line__isnull=True,
    ).select_related("asset", "driver").order_by("trip_date", "trip_ticket_no", "id"))


def billing_preview(client, period_from, period_to, selected_ids=None, vat_enabled=False, adjustments=None):
    candidates = eligible_billing_trips(client, period_from, period_to)
    selected = set(selected_ids if selected_ids is not None else [row.pk for row in candidates])
    rows = [row for row in candidates if row.pk in selected]
    base = money(sum((Decimal(row.base_trip_rate or 0) for row in rows), ZERO))
    extra = money(sum((Decimal(row.extra_total or 0) for row in rows), ZERO))
    gross = money(base + extra)
    vat = money(gross * Decimal("0.12")) if vat_enabled else ZERO
    adjustments = adjustments or []
    additions = money(sum((Decimal(row["amount"]) for row in adjustments if row["line_type"] == BillingAdjustment.LineType.ADDITION), ZERO))
    deductions = money(sum((Decimal(row["amount"]) for row in adjustments if row["line_type"] == BillingAdjustment.LineType.DEDUCTION), ZERO))
    return {
        "candidates": candidates, "selected": rows, "base_total": base, "extra_total": extra,
        "gross_total": gross, "vat_amount": vat, "additions_total": additions,
        "deductions_total": deductions, "grand_total": money(gross + vat + additions - deductions),
    }


@transaction.atomic
def create_billing(cleaned):
    client = cleaned["client"]
    selected_ids = cleaned["trip_ids"]
    locked = list(Trip.objects.select_for_update().filter(pk__in=selected_ids))
    valid = eligible_billing_trips(client, cleaned["period_from"], cleaned["period_to"])
    valid_by_id = {row.pk: row for row in valid}
    if len(locked) != len(set(selected_ids)) or any(pk not in valid_by_id for pk in selected_ids):
        raise ValueError("Billing eligibility changed. Load the completed trips again before saving.")
    rows = [valid_by_id[pk] for pk in selected_ids]
    preview = billing_preview(client, cleaned["period_from"], cleaned["period_to"], selected_ids, cleaned["vat_enabled"], cleaned["adjustments"])
    statement = BillingStatement.objects.create(
        billing_no=next_billing_no(cleaned["billing_date"]), client=client,
        billing_date=cleaned["billing_date"], period_from=cleaned["period_from"], period_to=cleaned["period_to"],
        base_charges_total=preview["base_total"], extra_charges_total=preview["extra_total"],
        gross_total=preview["gross_total"], vat_enabled=cleaned["vat_enabled"], vat_amount=preview["vat_amount"],
        additions_total=preview["additions_total"], deductions_total=preview["deductions_total"],
        grand_total=preview["grand_total"], status=BillingStatement.Status.OPEN, notes=cleaned.get("notes", ""),
    )
    BillingLine.objects.bulk_create([
        BillingLine(billing=statement, trip=row, amount_base=money(row.base_trip_rate), amount_extra=money(row.extra_total), amount_total=money(row.billable_total))
        for row in rows
    ])
    BillingAdjustment.objects.bulk_create([
        BillingAdjustment(billing=statement, **row) for row in cleaned["adjustments"]
    ])
    Trip.objects.filter(pk__in=selected_ids).update(status=Trip.Status.BILLED)
    return statement


def collection_total(statement):
    return money(statement.collections.aggregate(total=Sum("amount_paid"))["total"] or ZERO)


def outstanding_balance(statement):
    return money(Decimal(statement.grand_total or 0) - collection_total(statement))


def statement_of_account(client, *, mode="outstanding", as_of_date=None, date_from=None, date_to=None):
    statements = BillingStatement.objects.filter(client=client).order_by("billing_date", "billing_no", "id")
    if as_of_date:
        statements = statements.filter(billing_date__lte=as_of_date)
    if date_from:
        statements = statements.filter(billing_date__gte=date_from)
    if date_to:
        statements = statements.filter(billing_date__lte=date_to)
    rows = []
    total_billed = total_payments = total_balance = ZERO
    for statement in statements:
        collections = statement.collections.all()
        if as_of_date:
            collections = collections.filter(collection_date__lte=as_of_date)
        paid = money(collections.aggregate(total=Sum("amount_paid"))["total"] or ZERO)
        billed = money(statement.grand_total)
        balance = money(billed - paid)
        if mode == "outstanding" and balance == ZERO:
            continue
        rows.append({
            "statement": statement, "billing_no": statement.billing_no,
            "billing_date": statement.billing_date, "period_from": statement.period_from,
            "period_to": statement.period_to, "grand_total": billed,
            "payments": paid, "balance": balance, "status": statement.status,
        })
        total_billed = money(total_billed + billed)
        total_payments = money(total_payments + paid)
        total_balance = money(total_balance + balance)
    return {
        "client": client, "mode": mode, "as_of_date": as_of_date,
        "date_from": date_from, "date_to": date_to, "rows": rows,
        "total_billed": total_billed, "total_payments": total_payments,
        "total_balance": total_balance,
    }


def update_billing_status(statement):
    paid = collection_total(statement)
    outstanding = money(Decimal(statement.grand_total or 0) - paid)
    if outstanding <= 0:
        status = BillingStatement.Status.PAID
    elif paid > 0:
        status = BillingStatement.Status.PARTIAL
    else:
        status = BillingStatement.Status.OPEN
    BillingStatement.objects.filter(pk=statement.pk).update(status=status)
    statement.status = status
    return status


@transaction.atomic
def create_collection(cleaned):
    statement = BillingStatement.objects.select_for_update().select_related("client").get(pk=cleaned["billing"].pk)
    record = Collection.objects.create(
        collection_date=cleaned["collection_date"], client=statement.client, billing=statement,
        amount_paid=money(cleaned["amount_paid"]), reference_no=cleaned.get("reference_no", ""),
        payment_method=cleaned.get("payment_method", ""), notes=cleaned.get("notes", ""),
    )
    update_billing_status(statement)
    return record


@transaction.atomic
def delete_collection(record):
    statement = BillingStatement.objects.select_for_update().get(pk=record.billing_id) if record.billing_id else None
    record.delete()
    if statement:
        update_billing_status(statement)


@transaction.atomic
def delete_billing(statement):
    statement = BillingStatement.objects.select_for_update().get(pk=statement.pk)
    if statement.collections.exists():
        raise ValueError("This billing statement has collection records. Delete those collections first.")
    trip_ids = list(statement.lines.values_list("trip_id", flat=True))
    billing_no = statement.billing_no
    statement.delete()
    Trip.objects.filter(pk__in=trip_ids, status=Trip.Status.BILLED).update(status=Trip.Status.COMPLETED)
    return billing_no, len(trip_ids)
