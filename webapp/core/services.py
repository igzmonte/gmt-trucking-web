from decimal import Decimal
from datetime import date
from django.db.models import Count, F, Q, Sum
from django.db.models.functions import Coalesce
from .models import BillingStatement, CashAdvance, Trip, ValeRecord


def next_trip_ticket_no(trip_date=None):
    trip_date = trip_date or date.today()
    year = trip_date.year
    prefix = f"TT-{year}-"
    maximum = 0
    for value in Trip.objects.filter(trip_ticket_no__startswith=prefix).values_list("trip_ticket_no", flat=True):
        try:
            maximum = max(maximum, int(value.rsplit("-", 1)[1]))
        except (TypeError, ValueError, IndexError):
            continue
    return f"{prefix}{maximum + 1:06d}"

def dashboard_snapshot():
    ongoing = Trip.objects.filter(status=Trip.Status.ONGOING).count()
    unbilled = Trip.objects.filter(status=Trip.Status.COMPLETED, billing_line__isnull=True).count()
    open_advances = (ValeRecord.objects.filter(status="Open").aggregate(v=Sum("balance"))["v"] or Decimal("0")) + (CashAdvance.objects.filter(status="Open").aggregate(v=Sum("balance"))["v"] or Decimal("0"))
    billing_qs = BillingStatement.objects.select_related("client").annotate(paid_total=Coalesce(Sum("collections__amount_paid"), Decimal("0"))).order_by("-billing_date", "-id")
    receivables = sum((row.grand_total - row.paid_total for row in billing_qs), Decimal("0"))
    trips = [{"trip_ticket_no": row.trip_ticket_no, "trip_date": row.trip_date, "client_name": row.client.client_name if row.client else "", "status": row.status} for row in Trip.objects.select_related("client").order_by("-trip_date", "-id")[:12]]
    billings = [{"id": row.id, "billing_no": row.billing_no, "client_name": row.client.client_name, "status": row.status, "grand_total": row.grand_total, "outstanding": row.grand_total - row.paid_total} for row in billing_qs[:20]]
    return {"metrics": {"ongoing": ongoing, "unbilled": unbilled, "receivables": receivables, "advances": open_advances}, "trips": trips, "billings": billings}
