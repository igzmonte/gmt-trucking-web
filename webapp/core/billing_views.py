import csv
import json
from datetime import date

from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.core.paginator import Paginator
from django.db import IntegrityError
from django.db.models import Q
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render

from .access import can_edit, page_access
from .billing_services import (
    billing_preview, collection_total, create_billing, create_collection,
    delete_billing, delete_collection, eligible_billing_trips, outstanding_balance,
    statement_of_account,
)
from .forms import BillingForm, CollectionForm, StatementOfAccountForm
from .models import BillingStatement, Client, Collection


def _require_edit(request, page):
    if not can_edit(request.user, page):
        raise PermissionDenied


def _billing_queryset(request):
    rows = BillingStatement.objects.select_related("client")
    query = request.GET.get("q", "").strip()
    if query:
        rows = rows.filter(Q(billing_no__icontains=query) | Q(client__client_name__icontains=query) | Q(notes__icontains=query))
    status = request.GET.get("status", "").strip()
    if status in BillingStatement.Status.values:
        rows = rows.filter(status=status)
    return rows.order_by("-billing_date", "-id"), query, status


@page_access("Billing")
def billing_list(request):
    if request.method != "GET":
        raise PermissionDenied
    rows, query, status = _billing_queryset(request)
    page_obj = Paginator(rows, 25).get_page(request.GET.get("page"))
    for row in page_obj:
        row.paid_total_display = collection_total(row)
        row.outstanding_display = outstanding_balance(row)
    return render(request, "core/billing_list.html", {
        "page_title": "Billing", "page_obj": page_obj, "query": query, "selected_status": status,
        "status_choices": BillingStatement.Status.choices, "can_edit_page": can_edit(request.user, "Billing"),
    })


def _selection(request):
    source = request.POST if request.method == "POST" else request.GET
    try:
        client = Client.objects.get(pk=source.get("client"), active=True)
        period_from = date.fromisoformat(source.get("period_from", ""))
        period_to = date.fromisoformat(source.get("period_to", ""))
        return client, period_from, period_to
    except (Client.DoesNotExist, TypeError, ValueError):
        return None, None, None


@page_access("Billing")
def billing_new(request):
    _require_edit(request, "Billing")
    client, period_from, period_to = _selection(request)
    form = None
    preview = None
    selected_ids = []
    adjustments = []
    if request.method == "POST":
        form = BillingForm(request.POST)
        valid = form.is_valid()
        if client and period_from and period_to:
            selected_ids = form.cleaned_data.get("trip_ids") or []
            adjustments = form.cleaned_data.get("adjustments") or []
            preview = billing_preview(client, period_from, period_to, selected_ids, bool(form.cleaned_data.get("vat_enabled")), adjustments)
        if valid:
            try:
                statement = create_billing(form.cleaned_data)
            except (IntegrityError, ValueError) as exc:
                form.add_error(None, str(exc) or "One of these trips was already billed.")
            else:
                messages.success(request, f"Billing statement {statement.billing_no} created.")
                return redirect("billing_detail", pk=statement.pk)
    elif client and period_from and period_to:
        candidates = eligible_billing_trips(client, period_from, period_to)
        selected_ids = [row.pk for row in candidates]
        preview = billing_preview(client, period_from, period_to, selected_ids)
        form = BillingForm(initial={
            "client": client, "billing_date": date.today(), "period_from": period_from,
            "period_to": period_to, "vat_enabled": False, "notes": "",
            "trip_ids": json.dumps(selected_ids), "adjustments": "[]",
        })
    if form is None:
        form = BillingForm()
    return render(request, "core/billing_form.html", {
        "page_title": "New Billing Statement", "form": form, "preview": preview,
        "clients": Client.objects.filter(active=True).order_by("client_name", "id"),
        "selected_client": client, "selected_ids": selected_ids, "adjustments_data": adjustments,
        "default_period_from": period_from or date.today().replace(day=1),
        "default_period_to": period_to or date.today(),
    })


def _statement(pk):
    return get_object_or_404(BillingStatement.objects.select_related("client").prefetch_related(
        "lines__trip__asset", "lines__trip__driver", "adjustments", "collections"
    ), pk=pk)


def _billing_context(statement):
    return {
        "statement": statement, "paid_total": collection_total(statement),
        "outstanding": outstanding_balance(statement),
        "addition_lines": statement.adjustments.filter(line_type="Addition"),
        "deduction_lines": statement.adjustments.filter(line_type="Deduction"),
    }


@page_access("Billing")
def billing_detail(request, pk):
    context = _billing_context(_statement(pk))
    context.update({"page_title": "Billing Details", "can_edit_page": can_edit(request.user, "Billing")})
    return render(request, "core/billing_detail.html", context)


@page_access("Billing")
def billing_print(request, pk):
    return render(request, "core/billing_print.html", _billing_context(_statement(pk)))


@page_access("Billing")
def billing_delete(request, pk):
    _require_edit(request, "Billing")
    if request.method != "POST":
        raise PermissionDenied
    try:
        billing_no, trip_count = delete_billing(_statement(pk))
    except ValueError as exc:
        messages.error(request, str(exc))
        return redirect("billing_detail", pk=pk)
    messages.success(request, f"{billing_no} deleted; {trip_count} trip(s) reopened for billing.")
    return redirect("billing_list")


@page_access("Billing")
def billing_export(request):
    rows, _, _ = _billing_queryset(request)
    response = HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = 'attachment; filename="billing.csv"'
    writer = csv.writer(response)
    writer.writerow(("ID", "Billing No", "Date", "Client", "Base Charges", "Extra Charges", "Gross", "VAT", "Additions", "Deductions", "Grand Total", "Paid", "Outstanding", "Status"))
    for row in rows:
        writer.writerow((row.pk, row.billing_no, row.billing_date, row.client.client_name, row.base_charges_total, row.extra_charges_total, row.gross_total, row.vat_amount, row.additions_total, row.deductions_total, row.grand_total, collection_total(row), outstanding_balance(row), row.status))
    return response


def _soa_from_request(request):
    data = request.GET.copy()
    if not data.get("as_of_date"):
        data["as_of_date"] = date.today().isoformat()
    if not data.get("mode"):
        data["mode"] = "outstanding"
    form = StatementOfAccountForm(data or None)
    soa = None
    if form.is_valid():
        cleaned = form.cleaned_data
        soa = statement_of_account(
            cleaned["client"], mode=cleaned["mode"], as_of_date=cleaned["as_of_date"],
            date_from=cleaned["date_from"], date_to=cleaned["date_to"],
        )
    return form, soa


@page_access("Billing")
def billing_soa(request):
    if request.method != "GET":
        raise PermissionDenied
    form, soa = _soa_from_request(request)
    return render(request, "core/billing_soa.html", {"page_title": "Statement of Account", "form": form, "soa": soa})


@page_access("Billing")
def billing_soa_print(request):
    form, soa = _soa_from_request(request)
    if not form.is_valid() or soa is None:
        raise PermissionDenied
    return render(request, "core/billing_soa_print.html", {"soa": soa})


@page_access("Billing")
def billing_soa_export(request):
    form, soa = _soa_from_request(request)
    if not form.is_valid() or soa is None:
        raise PermissionDenied
    response = HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = 'attachment; filename="statement_of_account.csv"'
    writer = csv.writer(response)
    writer.writerow(("Billing No", "Billing Date", "Period From", "Period To", "Grand Total", "Payments", "Balance", "Status"))
    for row in soa["rows"]:
        writer.writerow((row["billing_no"], row["billing_date"], row["period_from"] or "", row["period_to"] or "", row["grand_total"], row["payments"], row["balance"], row["status"]))
    writer.writerow(("Totals", "", "", "", soa["total_billed"], soa["total_payments"], soa["total_balance"], ""))
    return response


def _collection_queryset(request):
    rows = Collection.objects.select_related("client", "billing")
    query = request.GET.get("q", "").strip()
    if query:
        rows = rows.filter(Q(client__client_name__icontains=query) | Q(billing__billing_no__icontains=query) | Q(reference_no__icontains=query) | Q(payment_method__icontains=query))
    return rows.order_by("-collection_date", "-id"), query


@page_access("Collections")
def collection_list(request):
    if request.method != "GET":
        raise PermissionDenied
    rows, query = _collection_queryset(request)
    return render(request, "core/collection_list.html", {
        "page_title": "Collections", "page_obj": Paginator(rows, 25).get_page(request.GET.get("page")),
        "query": query, "can_edit_page": can_edit(request.user, "Collections"),
    })


@page_access("Collections")
def collection_new(request):
    _require_edit(request, "Collections")
    billing = None
    if request.GET.get("billing"):
        billing = get_object_or_404(BillingStatement, pk=request.GET["billing"])
    form = CollectionForm(request.POST or None, billing=billing, initial={"collection_date": date.today(), "payment_method": "Bank Transfer"})
    if request.method == "POST" and form.is_valid():
        record = create_collection(form.cleaned_data)
        messages.success(request, "Collection saved and billing status updated.")
        return redirect("collection_detail", pk=record.pk)
    return render(request, "core/collection_form.html", {"page_title": "New Collection", "form": form, "selected_billing": billing})


@page_access("Collections")
def collection_detail(request, pk):
    record = get_object_or_404(Collection.objects.select_related("client", "billing"), pk=pk)
    return render(request, "core/collection_detail.html", {"page_title": "Collection Details", "record": record, "can_edit_page": can_edit(request.user, "Collections")})


@page_access("Collections")
def collection_delete(request, pk):
    _require_edit(request, "Collections")
    if request.method != "POST":
        raise PermissionDenied
    record = get_object_or_404(Collection, pk=pk)
    billing_id = record.billing_id
    delete_collection(record)
    messages.success(request, "Collection deleted and billing status recalculated.")
    return redirect("billing_detail", pk=billing_id) if billing_id else redirect("collections_list")


@page_access("Collections")
def collection_export(request):
    rows, _ = _collection_queryset(request)
    response = HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = 'attachment; filename="collections.csv"'
    writer = csv.writer(response)
    writer.writerow(("ID", "Date", "Client", "Billing No", "Amount Paid", "Reference", "Method", "Notes"))
    for row in rows:
        writer.writerow((row.pk, row.collection_date, row.client.client_name if row.client else "", row.billing.billing_no if row.billing else "", row.amount_paid, row.reference_no, row.payment_method, row.notes))
    return response
