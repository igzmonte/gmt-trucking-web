from django.urls import path
from . import views
from .master_views import delete_view, export_view, form_view, list_view
from .operations_views import (
    recurring_trip_delete, recurring_trip_edit, recurring_trip_export, recurring_trip_list,
    trip_delete, trip_detail, trip_edit, trip_export, trip_list, trip_new, trip_print,
)
from .maintenance_views import (
    payable_delete, payable_detail, payable_edit, payable_export, payable_list, payable_new,
    repair_delete, repair_detail, repair_edit, repair_export, repair_list, repair_new,
)
from .advance_views import (
    advance_list, cash_advance_delete, cash_advance_detail, cash_advance_edit,
    cash_advance_export, cash_advance_new, vale_delete, vale_detail, vale_edit,
    vale_export, vale_new,
)
from .payroll_views import payroll_delete, payroll_detail, payroll_export, payroll_list, payroll_new, payroll_print
from .billing_views import (
    billing_delete, billing_detail, billing_export, billing_list, billing_new, billing_print,
    billing_soa, billing_soa_export, billing_soa_print,
    collection_delete, collection_detail, collection_export, collection_list, collection_new,
)
from .report_views import report_export, report_print, report_workspace
from .user_views import user_deactivate, user_edit, user_export, user_list, user_new, user_password

urlpatterns = [
    path("", views.dashboard, name="dashboard"),
    path("reports/", report_workspace, name="reports"),
    path("reports/print/", report_print, name="reports_print"),
    path("reports/export.csv", report_export, name="reports_export"),
    path("recurring-trips/", recurring_trip_list, name="recurring_trips_list"),
    path("recurring-trips/<int:pk>/edit/", recurring_trip_edit, name="recurring_trips_edit"),
    path("recurring-trips/<int:pk>/delete/", recurring_trip_delete, name="recurring_trips_delete"),
    path("recurring-trips/export.csv", recurring_trip_export, name="recurring_trips_export"),
    path("trips/", trip_list, name="trips_list"),
    path("trips/new/", trip_new, name="trips_new"),
    path("trips/<int:pk>/", trip_detail, name="trips_detail"),
    path("trips/<int:pk>/edit/", trip_edit, name="trips_edit"),
    path("trips/<int:pk>/delete/", trip_delete, name="trips_delete"),
    path("trips/<int:pk>/print/", trip_print, name="trips_print"),
    path("trips/export.csv", trip_export, name="trips_export"),
    path("repairs/", repair_list, name="repairs_list"),
    path("repairs/new/", repair_new, name="repairs_new"),
    path("repairs/<int:pk>/", repair_detail, name="repairs_detail"),
    path("repairs/<int:pk>/edit/", repair_edit, name="repairs_edit"),
    path("repairs/<int:pk>/delete/", repair_delete, name="repairs_delete"),
    path("repairs/export.csv", repair_export, name="repairs_export"),
    path("payables/", payable_list, name="payables_list"),
    path("payables/new/", payable_new, name="payables_new"),
    path("payables/<int:pk>/", payable_detail, name="payables_detail"),
    path("payables/<int:pk>/edit/", payable_edit, name="payables_edit"),
    path("payables/<int:pk>/delete/", payable_delete, name="payables_delete"),
    path("payables/export.csv", payable_export, name="payables_export"),
    path("advances/", advance_list, name="advances_list"),
    path("advances/vale/new/", vale_new, name="vale_new"),
    path("advances/vale/<int:pk>/", vale_detail, name="vale_detail"),
    path("advances/vale/<int:pk>/edit/", vale_edit, name="vale_edit"),
    path("advances/vale/<int:pk>/delete/", vale_delete, name="vale_delete"),
    path("advances/vale/export.csv", vale_export, name="vale_export"),
    path("advances/cash-advance/new/", cash_advance_new, name="cash_advance_new"),
    path("advances/cash-advance/<int:pk>/", cash_advance_detail, name="cash_advance_detail"),
    path("advances/cash-advance/<int:pk>/edit/", cash_advance_edit, name="cash_advance_edit"),
    path("advances/cash-advance/<int:pk>/delete/", cash_advance_delete, name="cash_advance_delete"),
    path("advances/cash-advance/export.csv", cash_advance_export, name="cash_advance_export"),
    path("payroll/", payroll_list, name="payroll_list"),
    path("payroll/new/", payroll_new, name="payroll_new"),
    path("payroll/<int:pk>/", payroll_detail, name="payroll_detail"),
    path("payroll/<int:pk>/print/", payroll_print, name="payroll_print"),
    path("payroll/<int:pk>/delete/", payroll_delete, name="payroll_delete"),
    path("payroll/export.csv", payroll_export, name="payroll_export"),
    path("billing/", billing_list, name="billing_list"),
    path("billing/new/", billing_new, name="billing_new"),
    path("billing/soa/", billing_soa, name="billing_soa"),
    path("billing/soa/print/", billing_soa_print, name="billing_soa_print"),
    path("billing/soa/export.csv", billing_soa_export, name="billing_soa_export"),
    path("billing/<int:pk>/", billing_detail, name="billing_detail"),
    path("billing/<int:pk>/print/", billing_print, name="billing_print"),
    path("billing/<int:pk>/delete/", billing_delete, name="billing_delete"),
    path("billing/export.csv", billing_export, name="billing_export"),
    path("collections/", collection_list, name="collections_list"),
    path("collections/new/", collection_new, name="collection_new"),
    path("collections/<int:pk>/", collection_detail, name="collection_detail"),
    path("collections/<int:pk>/delete/", collection_delete, name="collection_delete"),
    path("collections/export.csv", collection_export, name="collections_export"),
    path("users/", user_list, name="users_list"),
    path("users/new/", user_new, name="users_new"),
    path("users/<int:pk>/edit/", user_edit, name="users_edit"),
    path("users/<int:pk>/password/", user_password, name="users_password"),
    path("users/<int:pk>/deactivate/", user_deactivate, name="users_deactivate"),
    path("users/export.csv", user_export, name="users_export"),
]

for key in ("employees", "fleet", "clients", "suppliers"):
    urlpatterns += [
        path(f"{key}/", list_view(key), name=f"{key}_list"),
        path(f"{key}/new/", form_view(key), name=f"{key}_new"),
        path(f"{key}/<int:pk>/edit/", form_view(key, editing=True), name=f"{key}_edit"),
        path(f"{key}/<int:pk>/delete/", delete_view(key), name=f"{key}_delete"),
        path(f"{key}/export.csv", export_view(key), name=f"{key}_export"),
    ]
