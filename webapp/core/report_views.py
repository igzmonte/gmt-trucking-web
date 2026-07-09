import csv
from datetime import date

from django import forms
from django.core.exceptions import PermissionDenied
from django.http import HttpResponse
from django.shortcuts import render
from django.utils import timezone

from .access import page_access
from .report_services import REPORTS, build_report


STATUS_CHOICES = (("", "All statuses"),) + tuple((value, value) for value in (
    "Planned", "Ongoing", "Completed", "Cancelled", "Billed", "Paid",
    "Open", "Partially Paid", "Closed", "Settled",
))


class ReportFilterForm(forms.Form):
    report = forms.ChoiceField(choices=tuple(REPORTS.items()))
    q = forms.CharField(required=False, label="Search")
    date_from = forms.DateField(required=False, widget=forms.DateInput(attrs={"type": "date"}))
    date_to = forms.DateField(required=False, widget=forms.DateInput(attrs={"type": "date"}))
    status = forms.ChoiceField(required=False, choices=STATUS_CHOICES)

    def clean(self):
        cleaned = super().clean()
        if cleaned.get("date_from") and cleaned.get("date_to") and cleaned["date_from"] > cleaned["date_to"]:
            self.add_error("date_to", "End date must be on or after start date.")
        return cleaned


def _report_from_request(request):
    data = request.GET.copy()
    if not data.get("report"):
        data["report"] = next(iter(REPORTS))
    form = ReportFilterForm(data)
    if form.is_valid():
        cleaned = form.cleaned_data
        result = build_report(cleaned["report"], query=cleaned["q"], date_from=cleaned["date_from"], date_to=cleaned["date_to"], status=cleaned["status"])
    else:
        result = build_report(next(iter(REPORTS)))
    return form, result


@page_access("Reports")
def report_workspace(request):
    if request.method != "GET":
        raise PermissionDenied
    form, result = _report_from_request(request)
    return render(request, "core/reports.html", {"page_title": "Reports", "filter_form": form, "report": result})


@page_access("Reports")
def report_export(request):
    form, result = _report_from_request(request)
    if not form.is_valid():
        raise PermissionDenied
    response = HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="{result["slug"]}.csv"'
    writer = csv.writer(response)
    writer.writerow([column["label"] for column in result["columns"]])
    writer.writerows(result["raw_rows"])
    return response


@page_access("Reports")
def report_print(request):
    if request.method != "GET":
        raise PermissionDenied
    form, result = _report_from_request(request)
    active_filters = []
    if form.is_valid():
        labels = {"q": "Search", "date_from": "Date From", "date_to": "Date To", "status": "Status"}
        for key, label in labels.items():
            value = form.cleaned_data.get(key)
            if value:
                active_filters.append((label, value))
    return render(request, "core/report_print.html", {
        "report": result,
        "filter_form": form,
        "active_filters": active_filters,
        "generated_at": timezone.localtime(),
    })
