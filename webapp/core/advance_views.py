import csv
from datetime import date

from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.core.paginator import Paginator
from django.db.models import Q, Sum
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render

from .access import can_edit, page_access
from .forms import CashAdvanceForm, ValeForm
from .models import CashAdvance, ValeRecord


PAGE = "Vale / Cash Advance"


def _require_edit(request):
    if not can_edit(request.user, PAGE):
        raise PermissionDenied


def _query(request, model):
    rows = model.objects.select_related("employee")
    query = request.GET.get("q", "").strip()
    if query:
        rows = rows.filter(Q(employee__full_name__icontains=query) | Q(employee__employee_code__icontains=query) | Q(notes__icontains=query))
    status = request.GET.get("status", "").strip()
    if status:
        rows = rows.filter(status=status)
    return rows.order_by("-date_granted", "-id"), query, status


@page_access(PAGE)
def advance_list(request):
    if request.method != "GET":
        raise PermissionDenied
    vale_rows, query, status = _query(request, ValeRecord)
    cash_rows, _, _ = _query(request, CashAdvance)
    return render(request, "core/advance_list.html", {
        "page_title": "Vale / Cash Advance", "query": query, "selected_status": status,
        "vale_page": Paginator(vale_rows, 25).get_page(request.GET.get("vale_page")),
        "cash_page": Paginator(cash_rows, 25).get_page(request.GET.get("cash_page")),
        "open_vale_total": ValeRecord.objects.filter(status="Open").aggregate(total=Sum("balance"))["total"] or 0,
        "open_cash_total": CashAdvance.objects.filter(status="Open").aggregate(total=Sum("balance"))["total"] or 0,
        "open_vale_count": ValeRecord.objects.filter(status="Open").count(),
        "open_cash_count": CashAdvance.objects.filter(status="Open").count(),
        "can_edit_page": can_edit(request.user, PAGE),
    })


def _form_view(request, kind, pk=None):
    _require_edit(request)
    is_vale = kind == "vale"
    model = ValeRecord if is_vale else CashAdvance
    form_class = ValeForm if is_vale else CashAdvanceForm
    record = get_object_or_404(model, pk=pk) if pk else None
    initial = {"date_granted": date.today(), "amount": 0}
    if is_vale:
        initial["installment_amount"] = 0
    form = form_class(request.POST or None, instance=record, initial=initial if not record else None)
    if request.method == "POST" and form.is_valid():
        saved = form.save()
        label = "Vale" if is_vale else "Cash advance"
        messages.success(request, f"{label} record {'updated' if record else 'saved'}.")
        return redirect(f"{kind}_detail", pk=saved.pk)
    return render(request, "core/advance_form.html", {
        "page_title": ("Edit " if record else "New ") + ("Vale Details" if is_vale else "Cash Advance Details"),
        "form": form, "record": record, "kind": kind, "is_vale": is_vale,
    })


@page_access(PAGE)
def vale_new(request):
    return _form_view(request, "vale")


@page_access(PAGE)
def vale_edit(request, pk):
    return _form_view(request, "vale", pk)


@page_access(PAGE)
def cash_advance_new(request):
    return _form_view(request, "cash_advance")


@page_access(PAGE)
def cash_advance_edit(request, pk):
    return _form_view(request, "cash_advance", pk)


def _detail(request, kind, pk):
    is_vale = kind == "vale"
    model = ValeRecord if is_vale else CashAdvance
    record = get_object_or_404(model.objects.select_related("employee"), pk=pk)
    employee_open_vale = ValeRecord.objects.filter(employee=record.employee, status="Open").aggregate(total=Sum("balance"))["total"] or 0
    employee_open_cash = CashAdvance.objects.filter(employee=record.employee, status="Open").aggregate(total=Sum("balance"))["total"] or 0
    return render(request, "core/advance_detail.html", {
        "page_title": "Vale Details" if is_vale else "Cash Advance Details", "record": record,
        "kind": kind, "is_vale": is_vale, "employee_open_vale": employee_open_vale,
        "employee_open_cash": employee_open_cash, "can_edit_page": can_edit(request.user, PAGE),
    })


@page_access(PAGE)
def vale_detail(request, pk):
    return _detail(request, "vale", pk)


@page_access(PAGE)
def cash_advance_detail(request, pk):
    return _detail(request, "cash_advance", pk)


def _delete(request, kind, pk):
    _require_edit(request)
    if request.method != "POST":
        raise PermissionDenied
    model = ValeRecord if kind == "vale" else CashAdvance
    get_object_or_404(model, pk=pk).delete()
    messages.success(request, ("Vale" if kind == "vale" else "Cash advance") + " record deleted. Existing payroll snapshots are unchanged.")
    return redirect("advances_list")


@page_access(PAGE)
def vale_delete(request, pk):
    return _delete(request, "vale", pk)


@page_access(PAGE)
def cash_advance_delete(request, pk):
    return _delete(request, "cash_advance", pk)


def _export(request, kind):
    model = ValeRecord if kind == "vale" else CashAdvance
    rows, _, _ = _query(request, model)
    response = HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="{kind}s.csv"'
    writer = csv.writer(response)
    if kind == "vale":
        writer.writerow(("ID", "Employee", "Date", "Amount", "Installment", "Balance", "Status", "Notes"))
        for row in rows:
            writer.writerow((row.pk, row.employee.full_name, row.date_granted, row.amount, row.installment_amount, row.balance, row.status, row.notes))
    else:
        writer.writerow(("ID", "Employee", "Date", "Amount", "Balance", "Applied", "Status", "Notes"))
        for row in rows:
            writer.writerow((row.pk, row.employee.full_name, row.date_granted, row.amount, row.balance, row.applied, row.status, row.notes))
    return response


@page_access(PAGE)
def vale_export(request):
    return _export(request, "vale")


@page_access(PAGE)
def cash_advance_export(request):
    return _export(request, "cash_advance")
