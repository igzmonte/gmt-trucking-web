import json
from decimal import Decimal, InvalidOperation

from django import forms
from django.core.exceptions import ValidationError
from django.db.models import Q

from .choice_labels import apply_choice_labels
from .models import Asset, BillingStatement, CashAdvance, Client, Collection, Employee, Payable, RecurringTripMaster, Repair, Supplier, Trip, TripEmployeePayItem, TripHelper, ValeRecord
from .services import next_trip_ticket_no


class StyledModelForm(forms.ModelForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for field in self.fields.values():
            field.widget.attrs.setdefault("class", "form-control")


class EmployeeForm(StyledModelForm):
    class Meta:
        model = Employee
        fields = ["employee_code", "full_name", "employee_type", "contact_no", "address", "date_hired", "employment_status", "payroll_basis", "daily_rate", "trip_rate", "notes"]
        widgets = {"date_hired": forms.DateInput(attrs={"type": "date"}), "address": forms.Textarea(attrs={"rows": 2}), "notes": forms.Textarea(attrs={"rows": 2})}

    def save(self, commit=True):
        instance = super().save(False)
        instance.active = instance.employment_status == Employee.Status.ACTIVE
        if commit:
            instance.save()
        return instance


class AssetForm(StyledModelForm):
    class Meta:
        model = Asset
        fields = ["asset_code", "asset_type", "plate_no", "make_model", "capacity_desc", "status", "assigned_employee", "notes"]
        widgets = {"notes": forms.Textarea(attrs={"rows": 2})}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["assigned_employee"].queryset = Employee.objects.filter(active=True)
        apply_choice_labels(self.fields["assigned_employee"])


class ClientForm(StyledModelForm):
    class Meta:
        model = Client
        fields = ["client_code", "client_name", "billing_address", "contact_person", "contact_no", "terms_days", "notes", "active"]
        widgets = {"billing_address": forms.Textarea(attrs={"rows": 2}), "notes": forms.Textarea(attrs={"rows": 2})}


class SupplierForm(StyledModelForm):
    class Meta:
        model = Supplier
        fields = ["supplier_name", "contact_person", "contact_no", "address", "notes"]
        widgets = {"address": forms.Textarea(attrs={"rows": 2}), "notes": forms.Textarea(attrs={"rows": 2})}


class RecurringTripForm(StyledModelForm):
    class Meta:
        model = RecurringTripMaster
        fields = [
            "master_code", "client", "job_description", "origin", "destination",
            "default_asset", "default_driver", "default_helper_count",
            "standard_base_rate", "driver_pay_rate", "helper_pay_rate",
            "default_extra_note", "remarks", "active",
        ]
        widgets = {
            "job_description": forms.Textarea(attrs={"rows": 2}),
            "default_extra_note": forms.Textarea(attrs={"rows": 2}),
            "remarks": forms.Textarea(attrs={"rows": 2}),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["job_description"].label = "Item / Job"
        self.fields["master_code"].required = True
        self.fields["client"].queryset = Client.objects.filter(active=True)
        self.fields["default_asset"].queryset = Asset.objects.order_by("asset_code")
        self.fields["default_driver"].queryset = Employee.objects.filter(
            active=True, employee_type=Employee.Type.DRIVER
        ).order_by("full_name")
        apply_choice_labels(self.fields["client"], self.fields["default_asset"], self.fields["default_driver"])

    def clean_default_helper_count(self):
        count = self.cleaned_data.get("default_helper_count") or 0
        if count > 10:
            raise ValidationError("Default helper count cannot exceed 10.")
        return count

    def clean(self):
        cleaned = super().clean()
        for name in ("standard_base_rate", "driver_pay_rate", "helper_pay_rate"):
            value = cleaned.get(name)
            if value is not None and value < 0:
                self.add_error(name, "Amount cannot be negative.")
        return cleaned


class TripForm(StyledModelForm):
    helper_1 = forms.ModelChoiceField(queryset=Employee.objects.none(), required=False)
    helper_2 = forms.ModelChoiceField(queryset=Employee.objects.none(), required=False)
    helper_3 = forms.ModelChoiceField(queryset=Employee.objects.none(), required=False)
    driver_pay_items = forms.CharField(required=False, widget=forms.HiddenInput)
    helper_pay_items = forms.CharField(required=False, widget=forms.HiddenInput)

    MONEY_FIELDS = (
        "base_trip_rate", "driver_pay_rate", "helper_pay_rate", "fuel_surcharge",
        "loading_fee", "unloading_fee", "waiting_fee", "tolls",
        "additional_stop_charge", "special_handling_fee", "other_charges",
    )
    EXTRA_FIELDS = (
        "fuel_surcharge", "loading_fee", "unloading_fee", "waiting_fee", "tolls",
        "additional_stop_charge", "special_handling_fee", "other_charges",
    )
    HELPER_LIMITS = {Asset.Type.EQUIPMENT: 0, Asset.Type.SMALL: 1, Asset.Type.CARGO: 2, Asset.Type.TRAILER: 3}

    class Meta:
        model = Trip
        fields = [
            "trip_ticket_no", "reference_no", "trip_type", "recurring_master", "trip_date", "client",
            "job_description", "origin", "destination", "asset", "driver",
            "dispatch_time", "arrival_time", "status", "base_trip_rate",
            "driver_pay_rate", "helper_pay_rate", "fuel_surcharge", "loading_fee",
            "unloading_fee", "waiting_fee", "tolls", "additional_stop_charge",
            "special_handling_fee", "other_charges", "notes",
        ]
        widgets = {
            "trip_date": forms.DateInput(attrs={"type": "date"}),
            "dispatch_time": forms.TimeInput(attrs={"type": "time"}),
            "arrival_time": forms.TimeInput(attrs={"type": "time"}),
            "job_description": forms.Textarea(attrs={"rows": 2}),
            "notes": forms.Textarea(attrs={"rows": 2}),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["trip_ticket_no"].required = False
        self.fields["trip_ticket_no"].label = "Trip Ticket / Waybill"
        self.fields["reference_no"].label = "Ref. No."
        self.fields["job_description"].label = "Item / Job"
        self.fields["client"].required = True
        self.fields["client"].queryset = Client.objects.filter(active=True).order_by("client_name")
        self.fields["asset"].queryset = Asset.objects.order_by("asset_code")
        self.fields["driver"].queryset = Employee.objects.filter(
            active=True, employee_type=Employee.Type.DRIVER
        ).order_by("full_name")
        helper_qs = Employee.objects.filter(
            active=True, employee_type=Employee.Type.HELPER
        ).order_by("full_name", "id")
        for name in ("helper_1", "helper_2", "helper_3"):
            self.fields[name].queryset = helper_qs
        master_filter = Q(active=True)
        if self.instance and self.instance.pk and self.instance.recurring_master_id:
            master_filter |= Q(pk=self.instance.recurring_master_id)
        self.fields["recurring_master"].queryset = RecurringTripMaster.objects.filter(master_filter).order_by("master_code")
        apply_choice_labels(
            self.fields["client"], self.fields["asset"], self.fields["driver"],
            self.fields["helper_1"], self.fields["helper_2"], self.fields["helper_3"],
            self.fields["recurring_master"],
        )
        if self.instance and self.instance.pk:
            helper_ids = list(self.instance.helper_assignments.order_by("helper_order", "id").values_list("employee_id", flat=True))
            for index, helper_id in enumerate(helper_ids[:3], start=1):
                self.fields[f"helper_{index}"].initial = helper_id
            pay_items = list(self.instance.employee_pay_items.order_by("employee_type", "sort_order", "id"))
            for employee_type, field_name in (("Driver", "driver_pay_items"), ("Helper", "helper_pay_items")):
                self.fields[field_name].initial = json.dumps([
                    {"label": item.label, "amount": str(item.amount)}
                    for item in pay_items if item.employee_type == employee_type
                ])

    def _clean_pay_items(self, field_name, employee_type):
        raw = self.cleaned_data.get(field_name) or "[]"
        try:
            rows = json.loads(raw)
        except (TypeError, ValueError):
            self.add_error(field_name, f"Invalid {employee_type.lower()} pay-item data.")
            return []
        if not isinstance(rows, list):
            self.add_error(field_name, f"Invalid {employee_type.lower()} pay-item data.")
            return []
        cleaned = []
        for index, row in enumerate(rows, start=1):
            label = str((row or {}).get("label", "")).strip() if isinstance(row, dict) else ""
            try:
                amount = Decimal(str((row or {}).get("amount", ""))) if isinstance(row, dict) else Decimal("0")
            except (InvalidOperation, TypeError, ValueError):
                amount = Decimal("0")
            if not label or amount <= 0:
                self.add_error(field_name, f"{employee_type} pay item {index} needs a label and an amount greater than zero.")
                continue
            cleaned.append({"employee_type": employee_type, "label": label, "amount": amount, "sort_order": index})
        return cleaned

    def clean(self):
        cleaned = super().clean()
        if not cleaned.get("trip_ticket_no") and cleaned.get("trip_date"):
            cleaned["trip_ticket_no"] = next_trip_ticket_no(cleaned["trip_date"])
            self.instance.trip_ticket_no = cleaned["trip_ticket_no"]
        trip_type = cleaned.get("trip_type")
        recurring_master = cleaned.get("recurring_master")
        if trip_type == Trip.Type.SPOT:
            cleaned["recurring_master"] = None
        elif trip_type == Trip.Type.RECURRING and not recurring_master:
            self.add_error("recurring_master", "Choose a recurring trip master.")

        helpers = [cleaned.get(f"helper_{index}") for index in range(1, 4)]
        populated = [helper for helper in helpers if helper]
        if len({helper.pk for helper in populated}) != len(populated):
            raise ValidationError("Helper selections must be unique.")
        for index in range(1, 3):
            if not helpers[index - 1] and helpers[index]:
                self.add_error(f"helper_{index + 1}", "Fill helper positions in order.")

        asset = cleaned.get("asset")
        maximum = self.HELPER_LIMITS.get(asset.asset_type, 3) if asset else 3
        if len(populated) > maximum:
            self.add_error("asset", f"{asset.asset_type} allows at most {maximum} helper(s).")
        for name in self.MONEY_FIELDS:
            value = cleaned.get(name)
            if value is not None and value < 0:
                self.add_error(name, "Amount cannot be negative.")
        self.cleaned_pay_items = self._clean_pay_items("driver_pay_items", "Driver") + self._clean_pay_items("helper_pay_items", "Helper")
        if any(item["employee_type"] == "Helper" for item in self.cleaned_pay_items) and not populated:
            self.add_error("helper_1", "Assign at least one helper before adding Helper pay items.")
        return cleaned

    def save(self, commit=True):
        instance = super().save(commit=False)
        pay_items = getattr(self, "cleaned_pay_items", [])
        instance.driver_additional_pay = sum((item["amount"] for item in pay_items if item["employee_type"] == "Driver"), Decimal("0"))
        instance.helper_additional_pay = sum((item["amount"] for item in pay_items if item["employee_type"] == "Helper"), Decimal("0"))
        if commit:
            instance.save()
            instance.helper_assignments.all().delete()
            helpers = [self.cleaned_data.get(f"helper_{index}") for index in range(1, 4)]
            TripHelper.objects.bulk_create([
                TripHelper(trip=instance, employee=helper, helper_order=index)
                for index, helper in enumerate((item for item in helpers if item), start=1)
            ])
            instance.employee_pay_items.all().delete()
            TripEmployeePayItem.objects.bulk_create([
                TripEmployeePayItem(trip=instance, **item) for item in pay_items
            ])
        return instance


class RepairForm(StyledModelForm):
    class Meta:
        model = Repair
        fields = [
            "repair_date", "asset", "repair_description", "meter_value", "supplier",
            "parts_cost", "labor_cost", "other_cost", "total_cost", "status", "notes",
            "auto_generate_payable",
        ]
        widgets = {
            "repair_date": forms.DateInput(attrs={"type": "date"}),
            "repair_description": forms.Textarea(attrs={"rows": 3}),
            "notes": forms.Textarea(attrs={"rows": 3}),
            "total_cost": forms.NumberInput(attrs={"readonly": True, "tabindex": "-1"}),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["asset"].queryset = Asset.objects.order_by("asset_code", "id")
        self.fields["supplier"].queryset = Supplier.objects.order_by("supplier_name", "id")
        apply_choice_labels(self.fields["asset"], self.fields["supplier"])
        self.fields["total_cost"].required = False

    def clean(self):
        cleaned = super().clean()
        total = Decimal("0")
        for name in ("parts_cost", "labor_cost", "other_cost"):
            value = cleaned.get(name) or Decimal("0")
            if value < 0:
                self.add_error(name, "Amount cannot be negative.")
            total += value
        cleaned["total_cost"] = total
        self.instance.total_cost = total
        return cleaned


class PayableForm(StyledModelForm):
    SOURCE_CHOICES = (("Manual", "Manual"), ("Repair", "Repair"), ("Expense", "Expense"))
    source_type = forms.ChoiceField(choices=SOURCE_CHOICES)

    class Meta:
        model = Payable
        fields = [
            "payable_date", "supplier", "source_type", "reference_no", "description",
            "amount", "due_date", "status", "notes",
        ]
        widgets = {
            "payable_date": forms.DateInput(attrs={"type": "date"}),
            "due_date": forms.DateInput(attrs={"type": "date"}),
            "description": forms.Textarea(attrs={"rows": 3}),
            "notes": forms.Textarea(attrs={"rows": 3}),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["supplier"].queryset = Supplier.objects.order_by("supplier_name", "id")
        apply_choice_labels(self.fields["supplier"])

    def clean_amount(self):
        amount = self.cleaned_data["amount"]
        if amount < 0:
            raise ValidationError("Amount cannot be negative.")
        return amount


class ValeForm(StyledModelForm):
    class Meta:
        model = ValeRecord
        fields = ["employee", "date_granted", "amount", "installment_amount", "notes"]
        widgets = {
            "date_granted": forms.DateInput(attrs={"type": "date"}),
            "notes": forms.Textarea(attrs={"rows": 3}),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        employee_filter = Q(active=True)
        if self.instance and self.instance.pk:
            employee_filter |= Q(pk=self.instance.employee_id)
        self.fields["employee"].queryset = Employee.objects.filter(employee_filter).order_by("full_name", "id")
        apply_choice_labels(self.fields["employee"])

    def clean(self):
        cleaned = super().clean()
        amount = cleaned.get("amount")
        installment = cleaned.get("installment_amount")
        if amount is not None and amount <= 0:
            self.add_error("amount", "Amount must be greater than zero.")
        if installment is not None and installment < 0:
            self.add_error("installment_amount", "Installment amount cannot be negative.")
        return cleaned

    def save(self, commit=True):
        record = super().save(False)
        if not record.pk:
            record.balance = record.amount
            record.status = "Open"
        else:
            record.status = "Settled" if record.balance <= 0 else "Open"
        if commit:
            record.save()
        return record


class CashAdvanceForm(StyledModelForm):
    class Meta:
        model = CashAdvance
        fields = ["employee", "date_granted", "amount", "notes"]
        widgets = {
            "date_granted": forms.DateInput(attrs={"type": "date"}),
            "notes": forms.Textarea(attrs={"rows": 3}),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        employee_filter = Q(active=True)
        if self.instance and self.instance.pk:
            employee_filter |= Q(pk=self.instance.employee_id)
        self.fields["employee"].queryset = Employee.objects.filter(employee_filter).order_by("full_name", "id")
        apply_choice_labels(self.fields["employee"])

    def clean_amount(self):
        amount = self.cleaned_data["amount"]
        if amount <= 0:
            raise ValidationError("Amount must be greater than zero.")
        return amount

    def save(self, commit=True):
        record = super().save(False)
        if not record.pk:
            record.balance = record.amount
            record.applied = False
            record.status = "Open"
        else:
            record.status = "Settled" if record.balance <= 0 else "Open"
            record.applied = record.balance <= 0
        if commit:
            record.save()
        return record


class PayrollForm(forms.Form):
    employee = forms.ModelChoiceField(queryset=Employee.objects.none())
    period_from = forms.DateField(widget=forms.DateInput(attrs={"type": "date"}))
    period_to = forms.DateField(widget=forms.DateInput(attrs={"type": "date"}))
    pay_date = forms.DateField(widget=forms.DateInput(attrs={"type": "date"}))
    unit_description = forms.CharField(max_length=200, required=False)
    days_count = forms.DecimalField(max_digits=10, decimal_places=2, min_value=0, initial=0)
    gross_pay = forms.DecimalField(max_digits=14, decimal_places=2, min_value=0, initial=0)
    additional_pay = forms.DecimalField(max_digits=14, decimal_places=2, initial=0)
    vale_deduction = forms.DecimalField(max_digits=14, decimal_places=2, min_value=0, initial=0)
    cash_advance_deduction = forms.DecimalField(max_digits=14, decimal_places=2, min_value=0, initial=0)
    sss = forms.DecimalField(max_digits=14, decimal_places=2, min_value=0, initial=0)
    philhealth = forms.DecimalField(max_digits=14, decimal_places=2, min_value=0, initial=0)
    pagibig = forms.DecimalField(max_digits=14, decimal_places=2, min_value=0, initial=0)
    withholding_tax = forms.DecimalField(max_digits=14, decimal_places=2, min_value=0, initial=0)
    change_deduction = forms.DecimalField(max_digits=14, decimal_places=2, min_value=0, initial=0)
    other_deduction = forms.DecimalField(max_digits=14, decimal_places=2, min_value=0, initial=0)
    remarks = forms.CharField(required=False, widget=forms.Textarea(attrs={"rows": 3}))

    def __init__(self, *args, preview=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.preview = preview
        self.fields["employee"].queryset = Employee.objects.filter(active=True).order_by("full_name", "id")
        apply_choice_labels(self.fields["employee"])
        for field in self.fields.values():
            field.widget.attrs.setdefault("class", "form-control")

    def clean(self):
        cleaned = super().clean()
        if cleaned.get("period_from") and cleaned.get("period_to") and cleaned["period_from"] > cleaned["period_to"]:
            self.add_error("period_to", "Period end must be on or after period start.")
        if self.preview:
            if cleaned.get("vale_deduction") is not None and cleaned["vale_deduction"] > self.preview["vale_deduction"]:
                self.add_error("vale_deduction", "Deduction cannot exceed the remaining Vale total.")
            if cleaned.get("cash_advance_deduction") is not None and cleaned["cash_advance_deduction"] > self.preview["cash_advance_deduction"]:
                self.add_error("cash_advance_deduction", "Deduction cannot exceed the remaining Cash Advance balance.")
        return cleaned


class BillingForm(forms.Form):
    client = forms.ModelChoiceField(queryset=Client.objects.none())
    billing_date = forms.DateField(widget=forms.DateInput(attrs={"type": "date"}))
    period_from = forms.DateField(widget=forms.DateInput(attrs={"type": "date"}))
    period_to = forms.DateField(widget=forms.DateInput(attrs={"type": "date"}))
    vat_enabled = forms.BooleanField(required=False)
    notes = forms.CharField(required=False, widget=forms.Textarea(attrs={"rows": 2}))
    trip_ids = forms.CharField(widget=forms.HiddenInput)
    adjustments = forms.CharField(required=False, widget=forms.HiddenInput)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["client"].queryset = Client.objects.filter(active=True).order_by("client_name", "id")
        apply_choice_labels(self.fields["client"])
        for field in self.fields.values():
            field.widget.attrs.setdefault("class", "form-control")

    def clean(self):
        cleaned = super().clean()
        if cleaned.get("period_from") and cleaned.get("period_to") and cleaned["period_from"] > cleaned["period_to"]:
            self.add_error("period_to", "Period end must be on or after period start.")
        try:
            raw_ids = json.loads(cleaned.get("trip_ids") or "[]")
            ids = []
            for value in raw_ids:
                value = int(value)
                if value not in ids:
                    ids.append(value)
            if not ids:
                raise ValueError
            cleaned["trip_ids"] = ids
        except (TypeError, ValueError, json.JSONDecodeError):
            self.add_error("trip_ids", "Select at least one completed trip.")
            cleaned["trip_ids"] = []
        try:
            raw_rows = json.loads(cleaned.get("adjustments") or "[]")
        except (TypeError, ValueError, json.JSONDecodeError):
            raw_rows = None
        normalized = []
        if not isinstance(raw_rows, list):
            self.add_error("adjustments", "Adjustment data is invalid.")
        else:
            for index, row in enumerate(raw_rows, start=1):
                line_type = str((row or {}).get("line_type", "")).strip().title() if isinstance(row, dict) else ""
                label = str((row or {}).get("label", "")).strip() if isinstance(row, dict) else ""
                try:
                    amount = Decimal(str((row or {}).get("amount", ""))) if isinstance(row, dict) else Decimal("0")
                except (InvalidOperation, TypeError, ValueError):
                    amount = Decimal("0")
                if line_type not in ("Addition", "Deduction") or not label or amount <= 0:
                    self.add_error("adjustments", f"Adjustment {index} needs a type, label, and amount greater than zero.")
                    continue
                normalized.append({"line_type": line_type, "label": label, "amount": amount, "sort_order": index})
        cleaned["adjustments"] = normalized
        return cleaned


class StatementOfAccountForm(forms.Form):
    MODE_CHOICES = (("outstanding", "Outstanding Only"), ("all", "All Activity"))
    client = forms.ModelChoiceField(queryset=Client.objects.none())
    mode = forms.ChoiceField(choices=MODE_CHOICES, initial="outstanding")
    as_of_date = forms.DateField(widget=forms.DateInput(attrs={"type": "date"}))
    date_from = forms.DateField(required=False, widget=forms.DateInput(attrs={"type": "date"}))
    date_to = forms.DateField(required=False, widget=forms.DateInput(attrs={"type": "date"}))

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["client"].queryset = Client.objects.filter(active=True).order_by("client_name", "id")
        apply_choice_labels(self.fields["client"])
        for field in self.fields.values():
            field.widget.attrs.setdefault("class", "form-control")

    def clean(self):
        cleaned = super().clean()
        if cleaned.get("date_from") and cleaned.get("date_to") and cleaned["date_from"] > cleaned["date_to"]:
            self.add_error("date_to", "End date must be on or after start date.")
        return cleaned


class CollectionForm(StyledModelForm):
    PAYMENT_CHOICES = tuple((value, value) for value in ("Bank Transfer", "Cash", "Check", "Online Transfer", "Other"))
    payment_method = forms.ChoiceField(choices=PAYMENT_CHOICES)

    class Meta:
        model = Collection
        fields = ["collection_date", "billing", "amount_paid", "reference_no", "payment_method", "notes"]
        widgets = {
            "collection_date": forms.DateInput(attrs={"type": "date"}),
            "notes": forms.Textarea(attrs={"rows": 3}),
        }

    def __init__(self, *args, billing=None, **kwargs):
        super().__init__(*args, **kwargs)
        queryset = BillingStatement.objects.filter(status__in=(BillingStatement.Status.OPEN, BillingStatement.Status.PARTIAL)).select_related("client").order_by("-billing_date", "-id")
        if billing:
            queryset = queryset.filter(pk=billing.pk)
            self.fields["billing"].initial = billing
        self.fields["billing"].queryset = queryset
        apply_choice_labels(self.fields["billing"])
