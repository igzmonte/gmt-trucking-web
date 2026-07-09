import csv
from dataclasses import dataclass

from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.db.models import Q
from django.db.models.deletion import ProtectedError
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render

from .access import can_edit, page_access
from .forms import AssetForm, ClientForm, EmployeeForm, SupplierForm
from .models import Asset, Client, Employee, Supplier


@dataclass(frozen=True)
class MasterSpec:
    key: str
    page: str
    model: type
    form: type
    search: tuple
    sort: dict
    columns: tuple
    csv_fields: tuple


SPECS = {
    "employees": MasterSpec("employees", "Employees", Employee, EmployeeForm, ("employee_code", "full_name", "contact_no"), {"name": "full_name", "code": "employee_code", "type": "employee_type", "status": "employment_status"}, (("Code", "employee_code"), ("Name", "full_name"), ("Type", "employee_type"), ("Basis", "payroll_basis"), ("Status", "employment_status")), ("id", "employee_code", "full_name", "employee_type", "payroll_basis", "daily_rate", "trip_rate", "employment_status")),
    "fleet": MasterSpec("fleet", "Fleet / Equipment", Asset, AssetForm, ("asset_code", "plate_no", "make_model"), {"code": "asset_code", "type": "asset_type", "status": "status", "plate": "plate_no"}, (("Code", "asset_code"), ("Type", "asset_type"), ("Plate", "plate_no"), ("Model", "make_model"), ("Status", "status")), ("id", "asset_code", "asset_type", "plate_no", "make_model", "capacity_desc", "status", "assigned_employee__full_name")),
    "clients": MasterSpec("clients", "Clients", Client, ClientForm, ("client_code", "client_name", "contact_person", "contact_no"), {"name": "client_name", "code": "client_code", "terms": "terms_days"}, (("Code", "client_code"), ("Client", "client_name"), ("Contact", "contact_person"), ("Phone", "contact_no"), ("Terms", "terms_days")), ("id", "client_code", "client_name", "billing_address", "contact_person", "contact_no", "terms_days", "active")),
    "suppliers": MasterSpec("suppliers", "Suppliers", Supplier, SupplierForm, ("supplier_name", "contact_person", "contact_no", "address"), {"name": "supplier_name", "contact": "contact_person"}, (("Supplier", "supplier_name"), ("Contact", "contact_person"), ("Phone", "contact_no"), ("Address", "address")), ("id", "supplier_name", "contact_person", "contact_no", "address", "notes")),
}


def _spec(key):
    return SPECS[key]


def _require_edit(request, spec):
    if not can_edit(request.user, spec.page):
        raise PermissionDenied


def list_view(key):
    spec = _spec(key)

    @page_access(spec.page)
    def view(request):
        create_form = None
        open_create_modal = False
        if request.method == "POST":
            _require_edit(request, spec)
            create_form = spec.form(request.POST)
            if create_form.is_valid():
                create_form.save()
                messages.success(request, f"{spec.page} record saved.")
                return redirect(f"{spec.key}_list")
            open_create_modal = True
        elif can_edit(request.user, spec.page):
            create_form = spec.form()

        qs = spec.model.objects.all()
        query = request.GET.get("q", "").strip()
        if query:
            predicate = Q()
            for field in spec.search:
                predicate |= Q(**{f"{field}__icontains": query})
            qs = qs.filter(predicate)
        sort_key = request.GET.get("sort", "")
        direction = "-" if request.GET.get("dir") == "desc" else ""
        if sort_key in spec.sort:
            qs = qs.order_by(direction + spec.sort[sort_key], "id")
        from django.core.paginator import Paginator
        page = Paginator(qs, 25).get_page(request.GET.get("page"))
        return render(request, "core/master_list.html", {
            "page_title": spec.page,
            "spec": spec,
            "page_obj": page,
            "query": query,
            "can_edit_page": can_edit(request.user, spec.page),
            "create_form": create_form,
            "open_create_modal": open_create_modal,
        })
    return view


def form_view(key, editing=False):
    spec = _spec(key)

    @page_access(spec.page)
    def view(request, pk=None):
        _require_edit(request, spec)
        instance = get_object_or_404(spec.model, pk=pk) if editing else None
        form = spec.form(request.POST or None, instance=instance)
        if request.method == "POST" and form.is_valid():
            form.save()
            messages.success(request, f"{spec.page} record saved.")
            return redirect(f"{spec.key}_list")
        return render(request, "core/master_form.html", {"page_title": f"{'Edit' if editing else 'New'} {spec.page}", "spec": spec, "form": form, "instance": instance})
    return view


def delete_view(key):
    spec = _spec(key)

    @page_access(spec.page)
    def view(request, pk):
        _require_edit(request, spec)
        if request.method != "POST":
            raise PermissionDenied
        instance = get_object_or_404(spec.model, pk=pk)
        try:
            instance.delete()
            messages.success(request, f"{spec.page} record deleted.")
        except ProtectedError:
            messages.error(request, "This record is already used by operational transactions and cannot be deleted.")
        return redirect(f"{spec.key}_list")
    return view


def export_view(key):
    spec = _spec(key)

    @page_access(spec.page)
    def view(request):
        response = HttpResponse(content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="{spec.key}.csv"'
        writer = csv.writer(response)
        writer.writerow(spec.csv_fields)
        writer.writerows(spec.model.objects.order_by("pk").values_list(*spec.csv_fields))
        return response
    return view
