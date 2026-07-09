import csv
from datetime import date

from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.core.paginator import Paginator
from django.db import transaction
from django.db.models import Q
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render

from .access import can_edit, page_access
from .forms import PayableForm, RepairForm
from .models import Payable, Repair


def _require_edit(request, page):
    if not can_edit(request.user, page):
        raise PermissionDenied


def _sort(queryset, request, choices, default):
    value = choices.get(request.GET.get("sort"), default)
    if request.GET.get("dir") == "desc":
        value = "-" + value
    return queryset.order_by(value, "-id")


def _create_generated_payable(repair):
    if not repair.auto_generate_payable or hasattr(repair, "generated_payable"):
        return None
    return Payable.objects.create(
        payable_date=repair.repair_date,
        supplier=repair.supplier,
        source_type="Repair",
        reference_no=f"REP-{repair.pk:05d}",
        description=repair.repair_description,
        amount=repair.total_cost,
        due_date=repair.repair_date,
        status=Payable.Status.OPEN,
        notes=repair.notes,
        linked_repair=repair,
    )


def _repair_queryset(request):
    rows = Repair.objects.select_related("asset", "supplier").prefetch_related("generated_payable")
    query = request.GET.get("q", "").strip()
    if query:
        rows = rows.filter(Q(repair_description__icontains=query) | Q(asset__asset_code__icontains=query) | Q(supplier__supplier_name__icontains=query) | Q(meter_value__icontains=query))
    status = request.GET.get("status", "").strip()
    if status in Repair.Status.values:
        rows = rows.filter(status=status)
    return _sort(rows, request, {"date": "repair_date", "asset": "asset__asset_code", "supplier": "supplier__supplier_name", "total": "total_cost", "status": "status"}, "repair_date"), query, status


@page_access("Repairs")
def repair_list(request):
    if request.method != "GET":
        raise PermissionDenied
    rows, query, status = _repair_queryset(request)
    return render(request, "core/repair_list.html", {"page_title": "Repairs", "page_obj": Paginator(rows, 25).get_page(request.GET.get("page")), "query": query, "selected_status": status, "status_choices": Repair.Status.choices, "can_edit_page": can_edit(request.user, "Repairs")})


@page_access("Repairs")
def repair_new(request):
    _require_edit(request, "Repairs")
    form = RepairForm(request.POST or None, initial={"repair_date": date.today(), "status": Repair.Status.OPEN, "parts_cost": 0, "labor_cost": 0, "other_cost": 0, "total_cost": 0})
    if request.method == "POST" and form.is_valid():
        with transaction.atomic():
            repair = form.save()
            payable = _create_generated_payable(repair)
        messages.success(request, "Repair saved." + (" A payable snapshot was generated." if payable else ""))
        return redirect("repairs_detail", pk=repair.pk)
    return render(request, "core/repair_form.html", {"page_title": "New Repair Details", "form": form})


@page_access("Repairs")
def repair_detail(request, pk):
    repair = get_object_or_404(Repair.objects.select_related("asset", "supplier", "generated_payable"), pk=pk)
    return render(request, "core/repair_detail.html", {"page_title": "Repair Details", "repair": repair, "can_edit_page": can_edit(request.user, "Repairs")})


@page_access("Repairs")
def repair_edit(request, pk):
    _require_edit(request, "Repairs")
    repair = get_object_or_404(Repair, pk=pk)
    form = RepairForm(request.POST or None, instance=repair)
    if request.method == "POST" and form.is_valid():
        with transaction.atomic():
            repair = form.save()
            payable = _create_generated_payable(repair)
        messages.success(request, "Repair updated." + (" A payable snapshot was generated." if payable else ""))
        return redirect("repairs_detail", pk=repair.pk)
    return render(request, "core/repair_form.html", {"page_title": "Edit Repair Details", "form": form, "repair": repair})


@page_access("Repairs")
def repair_delete(request, pk):
    _require_edit(request, "Repairs")
    if request.method != "POST":
        raise PermissionDenied
    repair = get_object_or_404(Repair, pk=pk)
    if hasattr(repair, "generated_payable"):
        messages.error(request, "This repair cannot be deleted while its generated payable exists. Delete the payable first.")
        return redirect("repairs_detail", pk=pk)
    repair.delete()
    messages.success(request, "Repair deleted.")
    return redirect("repairs_list")


@page_access("Repairs")
def repair_export(request):
    rows, _, _ = _repair_queryset(request)
    response = HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = 'attachment; filename="repairs.csv"'
    writer = csv.writer(response)
    writer.writerow(("ID", "Repair Date", "Asset", "Description", "Meter", "Supplier", "Parts Cost", "Labor Cost", "Other Cost", "Total Cost", "Status", "Payable Reference", "Notes"))
    for row in rows:
        payable = row.generated_payable if hasattr(row, "generated_payable") else None
        writer.writerow((row.pk, row.repair_date, row.asset.asset_code if row.asset else "", row.repair_description, row.meter_value, row.supplier.supplier_name if row.supplier else "", row.parts_cost, row.labor_cost, row.other_cost, row.total_cost, row.status, payable.reference_no if payable else "", row.notes))
    return response


def _payable_queryset(request):
    rows = Payable.objects.select_related("supplier", "linked_repair")
    query = request.GET.get("q", "").strip()
    if query:
        rows = rows.filter(Q(reference_no__icontains=query) | Q(description__icontains=query) | Q(supplier__supplier_name__icontains=query) | Q(source_type__icontains=query))
    status = request.GET.get("status", "").strip()
    if status in Payable.Status.values:
        rows = rows.filter(status=status)
    return _sort(rows, request, {"date": "payable_date", "supplier": "supplier__supplier_name", "amount": "amount", "due": "due_date", "status": "status"}, "payable_date"), query, status


@page_access("Payables")
def payable_list(request):
    if request.method != "GET":
        raise PermissionDenied
    rows, query, status = _payable_queryset(request)
    return render(request, "core/payable_list.html", {"page_title": "Payables", "page_obj": Paginator(rows, 25).get_page(request.GET.get("page")), "query": query, "selected_status": status, "status_choices": Payable.Status.choices, "can_edit_page": can_edit(request.user, "Payables")})


@page_access("Payables")
def payable_new(request):
    _require_edit(request, "Payables")
    form = PayableForm(request.POST or None, initial={"payable_date": date.today(), "due_date": date.today(), "source_type": "Manual", "status": Payable.Status.OPEN, "amount": 0})
    if request.method == "POST" and form.is_valid():
        payable = form.save()
        messages.success(request, "Payable saved.")
        return redirect("payables_detail", pk=payable.pk)
    return render(request, "core/payable_form.html", {"page_title": "New Payable Details", "form": form})


@page_access("Payables")
def payable_detail(request, pk):
    payable = get_object_or_404(Payable.objects.select_related("supplier", "linked_repair"), pk=pk)
    return render(request, "core/payable_detail.html", {"page_title": "Payable Details", "payable": payable, "can_edit_page": can_edit(request.user, "Payables")})


@page_access("Payables")
def payable_edit(request, pk):
    _require_edit(request, "Payables")
    payable = get_object_or_404(Payable, pk=pk)
    form = PayableForm(request.POST or None, instance=payable)
    if request.method == "POST" and form.is_valid():
        payable = form.save()
        messages.success(request, "Payable updated.")
        return redirect("payables_detail", pk=payable.pk)
    return render(request, "core/payable_form.html", {"page_title": "Edit Payable Details", "form": form, "payable": payable})


@page_access("Payables")
def payable_delete(request, pk):
    _require_edit(request, "Payables")
    if request.method != "POST":
        raise PermissionDenied
    payable = get_object_or_404(Payable, pk=pk)
    linked = payable.linked_repair_id is not None
    payable.delete()
    messages.success(request, "Payable deleted." + (" The repair record was retained." if linked else ""))
    return redirect("payables_list")


@page_access("Payables")
def payable_export(request):
    rows, _, _ = _payable_queryset(request)
    response = HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = 'attachment; filename="payables.csv"'
    writer = csv.writer(response)
    writer.writerow(("ID", "Payable Date", "Supplier", "Source Type", "Reference No", "Description", "Amount", "Due Date", "Status", "Linked Repair ID", "Notes"))
    for row in rows:
        writer.writerow((row.pk, row.payable_date, row.supplier.supplier_name if row.supplier else "", row.source_type, row.reference_no, row.description, row.amount, row.due_date or "", row.status, row.linked_repair_id or "", row.notes))
    return response
