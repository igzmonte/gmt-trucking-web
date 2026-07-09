import csv
from datetime import date

from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.core.paginator import Paginator
from django.db import IntegrityError
from django.db.models import Q
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render

from .access import can_edit, page_access
from .forms import PayrollForm
from .models import Employee, PayrollEntry
from .payroll_services import create_payroll, delete_payroll, money, payroll_preview


PAGE = "Payroll"


def _require_edit(request):
    if not can_edit(request.user, PAGE):
        raise PermissionDenied


def _payroll_queryset(request):
    rows = PayrollEntry.objects.select_related("employee")
    query = request.GET.get("q", "").strip()
    if query:
        rows = rows.filter(Q(employee__full_name__icontains=query) | Q(employee__employee_code__icontains=query) | Q(employee_type__icontains=query) | Q(remarks__icontains=query))
    return rows.order_by("-pay_date", "-id"), query


@page_access(PAGE)
def payroll_list(request):
    if request.method != "GET":
        raise PermissionDenied
    rows, query = _payroll_queryset(request)
    return render(request, "core/payroll_list.html", {
        "page_title": "Payroll", "page_obj": Paginator(rows, 25).get_page(request.GET.get("page")),
        "query": query, "can_edit_page": can_edit(request.user, PAGE),
    })


def _selection(request):
    source = request.POST if request.method == "POST" else request.GET
    employee = None
    period_from = period_to = None
    try:
        employee = Employee.objects.get(pk=source.get("employee"), active=True)
        period_from = date.fromisoformat(source.get("period_from", ""))
        period_to = date.fromisoformat(source.get("period_to", ""))
    except (Employee.DoesNotExist, TypeError, ValueError):
        return None, None, None
    return employee, period_from, period_to


@page_access(PAGE)
def payroll_new(request):
    _require_edit(request)
    employee, period_from, period_to = _selection(request)
    preview = payroll_preview(employee, period_from, period_to) if employee else None
    initial = None
    if preview:
        initial = {
            "employee": employee, "period_from": period_from, "period_to": period_to,
            "pay_date": date.today(), "unit_description": preview["unit_description"], "days_count": 0,
            "gross_pay": preview["gross_pay"], "additional_pay": preview["additional_pay"],
            "vale_deduction": preview["vale_deduction"], "cash_advance_deduction": preview["cash_advance_deduction"],
            "sss": 0, "philhealth": 0, "pagibig": 0, "withholding_tax": 0,
            "change_deduction": 0, "other_deduction": 0, "remarks": "",
        }
    form = PayrollForm(request.POST or None, initial=initial, preview=preview)
    if request.method == "POST":
        if not preview:
            form.add_error(None, "Employee or payroll period is invalid. Preview the period again.")
        elif form.is_valid():
            try:
                entry = create_payroll(form.cleaned_data, preview)
            except (IntegrityError, ValueError) as exc:
                form.add_error(None, str(exc) or "A trip in this payroll was already claimed.")
            else:
                messages.success(request, "Payroll entry saved and advance deductions applied.")
                return redirect("payroll_detail", pk=entry.pk)
    return render(request, "core/payroll_form.html", {
        "page_title": "New Payroll", "form": form, "preview": preview,
        "employees": Employee.objects.filter(active=True).order_by("full_name", "id"),
        "default_period_from": period_from or date.today().replace(day=1),
        "default_period_to": period_to or date.today(), "selected_employee": employee,
    })


def _entry(pk):
    return get_object_or_404(PayrollEntry.objects.select_related("employee").prefetch_related(
        "trip_links__trip__asset", "trip_links__trip__helper_assignments", "additional_lines"
    ), pk=pk)


def _detail_context(entry):
    deductions = [(label, getattr(entry, field)) for field, label in (
        ("vale_deduction", "Vale"), ("cash_advance_deduction", "Cash Advance"),
        ("sss", "SSS"), ("philhealth", "PhilHealth"), ("pagibig", "Pag-IBIG"),
        ("withholding_tax", "Withholding Tax"), ("change_deduction", "Change Deduction"),
        ("other_deduction", "Other Deduction"),
    )]
    trip_rows = []
    for link in entry.trip_links.all():
        trip = link.trip
        if entry.employee_type == Employee.Type.DRIVER:
            amount = trip.driver_pay_rate
        elif entry.employee_type == Employee.Type.HELPER:
            count = len(trip.helper_assignments.all())
            amount = money(0 if count <= 0 else trip.helper_pay_rate / count)
        else:
            amount = 0
        trip_rows.append({"trip": trip, "amount": amount})
    return {"entry": entry, "trip_rows": trip_rows, "deductions": deductions, "total_deductions": sum((amount for _, amount in deductions), 0)}


@page_access(PAGE)
def payroll_detail(request, pk):
    context = _detail_context(_entry(pk))
    context.update({"page_title": "Payroll Details", "can_edit_page": can_edit(request.user, PAGE)})
    return render(request, "core/payroll_detail.html", context)


@page_access(PAGE)
def payroll_print(request, pk):
    context = _detail_context(_entry(pk))
    return render(request, "core/payroll_print.html", context)


@page_access(PAGE)
def payroll_delete(request, pk):
    _require_edit(request)
    if request.method != "POST":
        raise PermissionDenied
    entry = _entry(pk)
    vale_unrestored, cash_unrestored = delete_payroll(entry)
    if vale_unrestored or cash_unrestored:
        messages.warning(request, f"Payroll deleted, but deleted/changed advance records prevented full restoration (Vale {vale_unrestored}, Cash Advance {cash_unrestored}).")
    else:
        messages.success(request, "Payroll deleted; Vale and Cash Advance deductions were restored.")
    return redirect("payroll_list")


@page_access(PAGE)
def payroll_export(request):
    rows, _ = _payroll_queryset(request)
    response = HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = 'attachment; filename="payroll.csv"'
    writer = csv.writer(response)
    writer.writerow(("ID", "Pay Date", "Employee", "Type", "Gross", "Additional Pay", "Vale Deduction", "Cash Advance Deduction", "SSS", "PhilHealth", "Pag-IBIG", "Withholding Tax", "Change Deduction", "Other Deduction", "Net"))
    for row in rows:
        writer.writerow((row.pk, row.pay_date, row.employee.full_name, row.employee_type, row.gross_pay, row.additional_pay, row.vale_deduction, row.cash_advance_deduction, row.sss, row.philhealth, row.pagibig, row.withholding_tax, row.change_deduction, row.other_deduction, row.net_pay))
    return response
