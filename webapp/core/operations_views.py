import csv
from datetime import date
from decimal import Decimal

from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.core.paginator import Paginator
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.db.models.deletion import ProtectedError
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render

from .access import can_edit, page_access
from .forms import RecurringTripForm, TripForm
from .models import Asset, RecurringTripMaster, Trip


EXTRA_FIELDS = (
    "fuel_surcharge", "loading_fee", "unloading_fee", "waiting_fee", "tolls",
    "additional_stop_charge", "special_handling_fee", "other_charges",
)


def _require_edit(request, page):
    if not can_edit(request.user, page):
        raise PermissionDenied


def _recurring_queryset(request):
    queryset = RecurringTripMaster.objects.select_related(
        "client", "default_asset", "default_driver"
    )
    query = request.GET.get("q", "").strip()
    if query:
        queryset = queryset.filter(
            Q(master_code__icontains=query)
            | Q(client__client_name__icontains=query)
            | Q(job_description__icontains=query)
            | Q(origin__icontains=query)
            | Q(destination__icontains=query)
        )
    sorts = {
        "code": "master_code", "client": "client__client_name",
        "rate": "standard_base_rate", "active": "active",
    }
    sort = sorts.get(request.GET.get("sort"), "master_code")
    if request.GET.get("dir") == "desc":
        sort = "-" + sort
    return queryset.order_by(sort, "id"), query


@page_access("Recurring Trips")
def recurring_trip_list(request):
    editable = can_edit(request.user, "Recurring Trips")
    form = RecurringTripForm()
    open_modal = False
    if request.method == "POST":
        _require_edit(request, "Recurring Trips")
        form = RecurringTripForm(request.POST)
        if form.is_valid():
            form.save()
            messages.success(request, "Recurring trip master saved.")
            return redirect("recurring_trips_list")
        open_modal = True
    queryset, query = _recurring_queryset(request)
    return render(request, "core/recurring_trip_list.html", {
        "page_title": "Recurring Trips",
        "page_obj": Paginator(queryset, 25).get_page(request.GET.get("page")),
        "query": query,
        "form": form,
        "can_edit_page": editable,
        "open_create_modal": open_modal,
    })


@page_access("Recurring Trips")
def recurring_trip_edit(request, pk):
    _require_edit(request, "Recurring Trips")
    instance = get_object_or_404(RecurringTripMaster, pk=pk)
    form = RecurringTripForm(request.POST or None, instance=instance)
    if request.method == "POST" and form.is_valid():
        form.save()
        messages.success(request, "Recurring trip master updated.")
        return redirect("recurring_trips_list")
    return render(request, "core/operation_form.html", {
        "page_title": "Edit Recurring Trip Master", "form": form,
        "cancel_url": "recurring_trips_list",
    })


@page_access("Recurring Trips")
def recurring_trip_delete(request, pk):
    _require_edit(request, "Recurring Trips")
    if request.method != "POST":
        raise PermissionDenied
    get_object_or_404(RecurringTripMaster, pk=pk).delete()
    messages.success(request, "Recurring trip master deleted; existing trips kept their transaction snapshots.")
    return redirect("recurring_trips_list")


@page_access("Recurring Trips")
def recurring_trip_export(request):
    response = HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = 'attachment; filename="recurring_trips.csv"'
    writer = csv.writer(response)
    writer.writerow(("ID", "Code", "Client", "Item / Job", "Origin", "Destination", "Asset", "Driver", "Helpers", "Base Rate", "Driver Pay", "Helper Pay", "Active"))
    rows = RecurringTripMaster.objects.select_related("client", "default_asset", "default_driver").order_by("pk")
    for row in rows:
        writer.writerow((row.pk, row.master_code, row.client.client_name if row.client else "", row.job_description, row.origin, row.destination, row.default_asset.asset_code if row.default_asset else "", row.default_driver.full_name if row.default_driver else "", row.default_helper_count, row.standard_base_rate, row.driver_pay_rate, row.helper_pay_rate, row.active))
    return response


def _trip_queryset(request):
    queryset = Trip.objects.select_related("client", "asset", "driver", "recurring_master").prefetch_related("helper_assignments__employee")
    query = request.GET.get("q", "").strip()
    if query:
        queryset = queryset.filter(
            Q(trip_ticket_no__icontains=query)
            | Q(reference_no__icontains=query)
            | Q(client__client_name__icontains=query)
            | Q(origin__icontains=query)
            | Q(destination__icontains=query)
            | Q(driver__full_name__icontains=query)
            | Q(asset__asset_code__icontains=query)
        )
    status = request.GET.get("status", "").strip()
    if status in Trip.Status.values:
        queryset = queryset.filter(status=status)
    sorts = {
        "ticket": "trip_ticket_no", "date": "trip_date", "client": "client__client_name",
        "status": "status", "total": "base_trip_rate",
    }
    sort = sorts.get(request.GET.get("sort"), "trip_date")
    if request.GET.get("dir", "desc") == "desc":
        sort = "-" + sort
    return queryset.order_by(sort, "-id"), query, status


def _trip_context(request):
    queryset, query, status = _trip_queryset(request)
    context = {
        "page_title": "Trips",
        "page_obj": Paginator(queryset, 25).get_page(request.GET.get("page")),
        "query": query,
        "selected_status": status,
        "status_choices": Trip.Status.choices,
        "can_edit_page": can_edit(request.user, "Trips"),
    }
    return context


def _trip_ui_data():
    masters = {}
    for row in RecurringTripMaster.objects.filter(active=True):
        masters[str(row.pk)] = {
            "client": row.client_id or "", "job_description": row.job_description,
            "origin": row.origin, "destination": row.destination,
            "asset": row.default_asset_id or "", "driver": row.default_driver_id or "",
            "helper_count": row.default_helper_count,
            "base_trip_rate": str(row.standard_base_rate),
            "driver_pay_rate": str(row.driver_pay_rate),
            "helper_pay_rate": str(row.helper_pay_rate),
            "notes": row.default_extra_note,
        }
    limits = {str(row.pk): TripForm.HELPER_LIMITS.get(row.asset_type, 3) for row in Asset.objects.all()}
    return {"master_defaults": masters, "asset_helper_limits": limits, "extra_field_names": EXTRA_FIELDS}


def _trip_form_page_context(form, page_title, cancel_detail_id=None):
    sections = [
        {
            "title": "Trip Overview", "css_class": "trip-overview-card",
            "fields": [form[name] for name in ("trip_ticket_no", "reference_no", "trip_date", "trip_type", "recurring_master", "status")],
        },
        {
            "title": "Route & Schedule", "css_class": "trip-route-card",
            "fields": [form[name] for name in ("client", "job_description", "origin", "destination", "dispatch_time", "arrival_time", "notes")],
        },
        {
            "title": "Unit & Crew", "css_class": "trip-crew-card",
            "fields": [form[name] for name in ("asset", "driver", "helper_1", "helper_2", "helper_3")],
        },
        {
            "title": "Employee Pay Rates", "css_class": "trip-employee-rate-card",
            "fields": [form[name] for name in ("driver_pay_rate", "helper_pay_rate")],
        },
        {
            "title": "Trip / Unit Charges", "css_class": "trip-unit-charge-card",
            "fields": [form[name] for name in (
                "base_trip_rate", "fuel_surcharge", "loading_fee", "unloading_fee", "waiting_fee", "tolls",
                "additional_stop_charge", "special_handling_fee", "other_charges",
            )],
        },
    ]
    context = {
        "page_title": page_title, "form": form, "trip_sections": sections,
        "cancel_detail_id": cancel_detail_id,
    }
    context.update(_trip_ui_data())
    return context


@page_access("Trips")
def trip_list(request):
    if request.method != "GET":
        raise PermissionDenied
    return render(request, "core/trip_list.html", _trip_context(request))


@page_access("Trips")
def trip_new(request):
    _require_edit(request, "Trips")
    form = TripForm(
        request.POST or None,
        initial={"trip_date": date.today(), "trip_type": Trip.Type.SPOT, "status": Trip.Status.PLANNED},
    )
    if request.method == "POST" and form.is_valid():
        try:
            with transaction.atomic():
                trip = form.save()
        except IntegrityError:
            form.add_error("trip_ticket_no", "This trip ticket number is already in use.")
        else:
            messages.success(request, "Trip record saved.")
            return redirect("trips_detail", pk=trip.pk)
    return render(request, "core/trip_form_page.html", _trip_form_page_context(form, "New Trip Details"))


def _trip_record(pk):
    return get_object_or_404(
        Trip.objects.select_related("client", "asset", "driver", "recurring_master").prefetch_related(
            "helper_assignments__employee", "employee_pay_items"
        ),
        pk=pk,
    )


@page_access("Trips")
def trip_detail(request, pk):
    trip = _trip_record(pk)
    extra_lines = [
        (label, getattr(trip, field)) for field, label in (
            ("fuel_surcharge", "Fuel Surcharge"), ("loading_fee", "Loading Fee"),
            ("unloading_fee", "Unloading Fee"), ("waiting_fee", "Waiting / Detention"),
            ("tolls", "Tolls"), ("additional_stop_charge", "Additional Stop"),
            ("special_handling_fee", "Special Handling / Permit"), ("other_charges", "Other Charges"),
        ) if getattr(trip, field)
    ]
    return render(request, "core/trip_detail.html", {
        "page_title": "Trip Details", "trip": trip, "extra_lines": extra_lines,
        "can_edit_page": can_edit(request.user, "Trips"),
    })


@page_access("Trips")
def trip_edit(request, pk):
    _require_edit(request, "Trips")
    instance = get_object_or_404(Trip, pk=pk)
    form = TripForm(request.POST or None, instance=instance)
    if request.method == "POST" and form.is_valid():
        try:
            with transaction.atomic():
                form.save()
        except IntegrityError:
            form.add_error("trip_ticket_no", "This trip ticket number is already in use.")
        else:
            messages.success(request, "Trip record updated.")
            return redirect("trips_detail", pk=instance.pk)
    return render(request, "core/trip_form_page.html", _trip_form_page_context(
        form, f"Edit Trip {instance.trip_ticket_no}", cancel_detail_id=instance.pk
    ))


@page_access("Trips")
def trip_delete(request, pk):
    _require_edit(request, "Trips")
    if request.method != "POST":
        raise PermissionDenied
    instance = get_object_or_404(Trip, pk=pk)
    ticket = instance.trip_ticket_no
    try:
        instance.delete()
    except ProtectedError:
        messages.error(request, "This trip is already used by billing or payroll and cannot be deleted.")
    else:
        messages.success(request, f"Trip {ticket} deleted.")
    return redirect("trips_list")


@page_access("Trips")
def trip_export(request):
    response = HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = 'attachment; filename="trips.csv"'
    writer = csv.writer(response)
    writer.writerow(("ID", "Trip Ticket / Waybill", "Ref. No.", "Type", "Date", "Client", "Route", "Asset", "Driver", "Helpers", "Status", "Base Rate", "Extra Charges", "Billable Total"))
    rows = Trip.objects.select_related("client", "asset", "driver").prefetch_related("helper_assignments__employee").order_by("pk")
    for row in rows:
        extra = sum((getattr(row, name) or Decimal("0") for name in EXTRA_FIELDS), Decimal("0"))
        helpers = "; ".join(link.employee.full_name for link in row.helper_assignments.all())
        writer.writerow((row.pk, row.trip_ticket_no, row.reference_no, row.trip_type, row.trip_date, row.client.client_name if row.client else "", f"{row.origin} -> {row.destination}", row.asset.asset_code if row.asset else "", row.driver.full_name if row.driver else "", helpers, row.status, row.base_trip_rate, extra, row.base_trip_rate + extra))
    return response


@page_access("Trips")
def trip_print(request, pk):
    trip = _trip_record(pk)
    extra_lines = [
        (label, getattr(trip, field)) for field, label in (
            ("fuel_surcharge", "Fuel Surcharge"), ("loading_fee", "Loading Fee"),
            ("unloading_fee", "Unloading Fee"), ("waiting_fee", "Waiting / Detention"),
            ("tolls", "Tolls"), ("additional_stop_charge", "Additional Stop"),
            ("special_handling_fee", "Special Handling / Permit"), ("other_charges", "Other Charges"),
        ) if getattr(trip, field)
    ]
    return render(request, "core/trip_ticket.html", {
        "trip": trip, "extra_lines": extra_lines, "page_title": f"Trip Ticket / Waybill {trip.trip_ticket_no}",
    })
