from django.conf import settings
from django.core.validators import MinValueValidator
from django.db import models


MONEY = {"max_digits": 14, "decimal_places": 2, "default": 0}


class SystemSetting(models.Model):
    key = models.CharField(max_length=100, primary_key=True)
    value = models.TextField(blank=True)

    class Meta:
        ordering = ["key"]


class Employee(models.Model):
    class Type(models.TextChoices):
        DRIVER = "Driver", "Driver"
        HELPER = "Helper", "Helper"
        OPERATOR = "Operator", "Operator"
        MECHANIC = "Mechanic", "Mechanic"
        OFFICE = "Office Staff", "Office Staff"

    class Status(models.TextChoices):
        ACTIVE = "Active", "Active"
        INACTIVE = "Inactive", "Inactive"

    class PayrollBasis(models.TextChoices):
        PER_TRIP = "Per Trip", "Per Trip"
        PER_DAY = "Per Day", "Per Day"
        MANUAL = "Manual", "Manual"

    employee_code = models.CharField(max_length=50, unique=True, null=True, blank=True)
    full_name = models.CharField(max_length=200)
    employee_type = models.CharField(max_length=30, choices=Type.choices)
    contact_no = models.CharField(max_length=50, blank=True)
    address = models.TextField(blank=True)
    date_hired = models.DateField(null=True, blank=True)
    employment_status = models.CharField(max_length=20, choices=Status.choices, default=Status.ACTIVE)
    payroll_basis = models.CharField(max_length=20, choices=PayrollBasis.choices, default=PayrollBasis.PER_TRIP)
    daily_rate = models.DecimalField(**MONEY)
    trip_rate = models.DecimalField(**MONEY)
    notes = models.TextField(blank=True)
    active = models.BooleanField(default=True, db_index=True)

    class Meta:
        ordering = ["full_name", "id"]

    def __str__(self):
        return self.full_name


class Asset(models.Model):
    class Type(models.TextChoices):
        SMALL = "Small Truck", "Small Truck"
        CARGO = "Cargo Truck", "Cargo Truck"
        TRAILER = "Trailer Truck", "Trailer Truck"
        EQUIPMENT = "Equipment", "Equipment"

    class Status(models.TextChoices):
        AVAILABLE = "Available", "Available"
        IN_USE = "In Use", "In Use"
        REPAIR = "Under Repair", "Under Repair"
        INACTIVE = "Inactive", "Inactive"

    asset_code = models.CharField(max_length=50, unique=True)
    asset_type = models.CharField(max_length=30, choices=Type.choices)
    plate_no = models.CharField(max_length=50, blank=True)
    make_model = models.CharField(max_length=200, blank=True)
    capacity_desc = models.CharField(max_length=200, blank=True)
    status = models.CharField(max_length=30, choices=Status.choices, default=Status.AVAILABLE)
    assigned_employee = models.ForeignKey(Employee, null=True, blank=True, on_delete=models.SET_NULL, related_name="assigned_assets")
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ["asset_code", "id"]

    def __str__(self):
        return self.asset_code


class Client(models.Model):
    client_code = models.CharField(max_length=50, unique=True, null=True, blank=True)
    client_name = models.CharField(max_length=200, unique=True)
    billing_address = models.TextField(blank=True)
    contact_person = models.CharField(max_length=200, blank=True)
    contact_no = models.CharField(max_length=50, blank=True)
    terms_days = models.PositiveIntegerField(default=30)
    notes = models.TextField(blank=True)
    active = models.BooleanField(default=True, db_index=True)

    class Meta:
        ordering = ["client_name", "id"]

    def __str__(self):
        return self.client_name


class Supplier(models.Model):
    supplier_name = models.CharField(max_length=200, unique=True)
    contact_person = models.CharField(max_length=200, blank=True)
    contact_no = models.CharField(max_length=50, blank=True)
    address = models.TextField(blank=True)
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ["supplier_name", "id"]

    def __str__(self):
        return self.supplier_name


class RecurringTripMaster(models.Model):
    master_code = models.CharField(max_length=50, unique=True, null=True, blank=True)
    client = models.ForeignKey(Client, null=True, blank=True, on_delete=models.PROTECT, related_name="recurring_trips")
    job_description = models.TextField(blank=True)
    origin = models.CharField(max_length=200, blank=True)
    destination = models.CharField(max_length=200, blank=True)
    default_asset = models.ForeignKey(Asset, null=True, blank=True, on_delete=models.PROTECT, related_name="recurring_defaults")
    default_driver = models.ForeignKey(Employee, null=True, blank=True, on_delete=models.PROTECT, related_name="recurring_driver_defaults")
    default_helper_count = models.PositiveIntegerField(default=0)
    standard_base_rate = models.DecimalField(**MONEY)
    driver_pay_rate = models.DecimalField(**MONEY)
    helper_pay_rate = models.DecimalField(**MONEY)
    default_extra_note = models.TextField(blank=True)
    remarks = models.TextField(blank=True)
    active = models.BooleanField(default=True, db_index=True)

    class Meta:
        ordering = ["master_code", "id"]

    def __str__(self):
        return self.master_code or f"Recurring Master {self.pk}"


class Trip(models.Model):
    class Type(models.TextChoices):
        SPOT = "Spot Trip", "Spot Trip"
        RECURRING = "Recurring Trip", "Recurring Trip"

    class Status(models.TextChoices):
        PLANNED = "Planned", "Planned"
        ONGOING = "Ongoing", "Ongoing"
        COMPLETED = "Completed", "Completed"
        CANCELLED = "Cancelled", "Cancelled"
        BILLED = "Billed", "Billed"
        PAID = "Paid", "Paid"

    trip_ticket_no = models.CharField(max_length=50, unique=True)
    reference_no = models.CharField(max_length=100, blank=True)
    trip_type = models.CharField(max_length=30, choices=Type.choices)
    recurring_master = models.ForeignKey(RecurringTripMaster, null=True, blank=True, on_delete=models.SET_NULL, related_name="trips")
    trip_date = models.DateField(db_index=True)
    client = models.ForeignKey(Client, null=True, blank=True, on_delete=models.PROTECT, related_name="trips")
    job_description = models.TextField(blank=True)
    origin = models.CharField(max_length=200, blank=True)
    destination = models.CharField(max_length=200, blank=True)
    asset = models.ForeignKey(Asset, null=True, blank=True, on_delete=models.PROTECT, related_name="trips")
    driver = models.ForeignKey(Employee, null=True, blank=True, on_delete=models.PROTECT, related_name="driven_trips")
    dispatch_time = models.TimeField(null=True, blank=True)
    arrival_time = models.TimeField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PLANNED, db_index=True)
    base_trip_rate = models.DecimalField(**MONEY)
    driver_pay_rate = models.DecimalField(**MONEY)
    helper_pay_rate = models.DecimalField(**MONEY)
    driver_additional_pay = models.DecimalField(**MONEY)
    helper_additional_pay = models.DecimalField(**MONEY)
    fuel_surcharge = models.DecimalField(**MONEY)
    loading_fee = models.DecimalField(**MONEY)
    unloading_fee = models.DecimalField(**MONEY)
    waiting_fee = models.DecimalField(**MONEY)
    tolls = models.DecimalField(**MONEY)
    additional_stop_charge = models.DecimalField(**MONEY)
    special_handling_fee = models.DecimalField(**MONEY)
    other_charges = models.DecimalField(**MONEY)
    notes = models.TextField(blank=True)
    helpers = models.ManyToManyField(Employee, through="TripHelper", related_name="helper_trips")

    class Meta:
        ordering = ["-trip_date", "-id"]

    def __str__(self):
        return self.trip_ticket_no

    @property
    def extra_total(self):
        fields = (
            "fuel_surcharge", "loading_fee", "unloading_fee", "waiting_fee", "tolls",
            "additional_stop_charge", "special_handling_fee", "other_charges",
        )
        return sum((getattr(self, field) for field in fields), 0)

    @property
    def billable_total(self):
        return self.base_trip_rate + self.extra_total

    @property
    def helper_names(self):
        return ", ".join(link.employee.full_name for link in self.helper_assignments.all())


class TripHelper(models.Model):
    trip = models.ForeignKey(Trip, on_delete=models.CASCADE, related_name="helper_assignments")
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="trip_helper_assignments")
    helper_order = models.PositiveIntegerField(default=1)

    class Meta:
        ordering = ["trip_id", "helper_order", "id"]
        constraints = [
            models.UniqueConstraint(fields=["trip", "employee"], name="unique_trip_helper"),
            models.UniqueConstraint(fields=["trip", "helper_order"], name="unique_trip_helper_order"),
        ]


class TripEmployeePayItem(models.Model):
    class EmployeeType(models.TextChoices):
        DRIVER = "Driver", "Driver"
        HELPER = "Helper", "Helper"

    trip = models.ForeignKey(Trip, on_delete=models.CASCADE, related_name="employee_pay_items")
    employee_type = models.CharField(max_length=20, choices=EmployeeType.choices)
    label = models.CharField(max_length=200)
    amount = models.DecimalField(**MONEY)
    sort_order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["employee_type", "sort_order", "id"]


class Repair(models.Model):
    class Status(models.TextChoices):
        OPEN = "Open", "Open"
        ONGOING = "Ongoing", "Ongoing"
        COMPLETED = "Completed", "Completed"
        PAID = "Paid", "Paid"

    repair_date = models.DateField(db_index=True)
    asset = models.ForeignKey(Asset, null=True, blank=True, on_delete=models.PROTECT, related_name="repairs")
    repair_description = models.TextField()
    meter_value = models.CharField(max_length=100, blank=True)
    supplier = models.ForeignKey(Supplier, null=True, blank=True, on_delete=models.PROTECT, related_name="repairs")
    parts_cost = models.DecimalField(**MONEY)
    labor_cost = models.DecimalField(**MONEY)
    other_cost = models.DecimalField(**MONEY)
    total_cost = models.DecimalField(**MONEY)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.OPEN)
    notes = models.TextField(blank=True)
    auto_generate_payable = models.BooleanField(default=False)

    def __str__(self):
        return f"Repair #{self.pk}: {self.repair_description}" if self.pk else self.repair_description


class Payable(models.Model):
    class Status(models.TextChoices):
        OPEN = "Open", "Open"
        PARTIAL = "Partially Paid", "Partially Paid"
        PAID = "Paid", "Paid"
        CANCELLED = "Cancelled", "Cancelled"

    payable_date = models.DateField(db_index=True)
    supplier = models.ForeignKey(Supplier, null=True, blank=True, on_delete=models.PROTECT, related_name="payables")
    source_type = models.CharField(max_length=50, blank=True)
    reference_no = models.CharField(max_length=100, blank=True)
    description = models.TextField(blank=True)
    amount = models.DecimalField(**MONEY)
    due_date = models.DateField(null=True, blank=True, db_index=True)
    status = models.CharField(max_length=30, choices=Status.choices, default=Status.OPEN, db_index=True)
    notes = models.TextField(blank=True)
    linked_repair = models.OneToOneField(Repair, null=True, blank=True, on_delete=models.SET_NULL, related_name="generated_payable")

    def __str__(self):
        return self.reference_no or f"Payable #{self.pk}"


class ValeRecord(models.Model):
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="vale_records")
    date_granted = models.DateField(db_index=True)
    amount = models.DecimalField(**MONEY)
    installment_amount = models.DecimalField(**MONEY)
    balance = models.DecimalField(**MONEY)
    status = models.CharField(max_length=20, default="Open", db_index=True)
    notes = models.TextField(blank=True)

    def __str__(self):
        return f"Vale #{self.pk} - {self.employee}" if self.pk else "Vale"


class CashAdvance(models.Model):
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="cash_advances")
    date_granted = models.DateField(db_index=True)
    amount = models.DecimalField(**MONEY)
    balance = models.DecimalField(**MONEY)
    applied = models.BooleanField(default=False)
    status = models.CharField(max_length=20, default="Open", db_index=True)
    notes = models.TextField(blank=True)

    def __str__(self):
        return f"Cash Advance #{self.pk} - {self.employee}" if self.pk else "Cash Advance"


class PayrollEntry(models.Model):
    pay_date = models.DateField(db_index=True)
    period_from = models.DateField()
    period_to = models.DateField()
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="payroll_entries")
    employee_type = models.CharField(max_length=30, blank=True)
    payroll_basis = models.CharField(max_length=30, blank=True)
    unit_description = models.CharField(max_length=200, blank=True)
    trips_count = models.PositiveIntegerField(default=0)
    days_count = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    gross_pay = models.DecimalField(**MONEY)
    additional_pay = models.DecimalField(**MONEY)
    driver_trip_additional_pay = models.DecimalField(**MONEY)
    helper_trip_additional_pay = models.DecimalField(**MONEY)
    vale_deduction = models.DecimalField(**MONEY)
    cash_advance_deduction = models.DecimalField(**MONEY)
    sss = models.DecimalField(**MONEY)
    philhealth = models.DecimalField(**MONEY)
    pagibig = models.DecimalField(**MONEY)
    withholding_tax = models.DecimalField(**MONEY)
    change_deduction = models.DecimalField(**MONEY)
    other_deduction = models.DecimalField(**MONEY)
    net_pay = models.DecimalField(**MONEY)
    remarks = models.TextField(blank=True)
    trips = models.ManyToManyField(Trip, through="PayrollTrip", related_name="payroll_entries")

    def __str__(self):
        return f"Payroll #{self.pk} - {self.employee}" if self.pk else "Payroll"


class PayrollTrip(models.Model):
    payroll = models.ForeignKey(PayrollEntry, on_delete=models.CASCADE, related_name="trip_links")
    trip = models.ForeignKey(Trip, on_delete=models.PROTECT, related_name="payroll_links")
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="payroll_trip_claims")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["payroll", "trip"], name="unique_payroll_trip"),
            models.UniqueConstraint(fields=["employee", "trip"], name="unique_employee_trip_payroll"),
        ]


class PayrollAdditionalLine(models.Model):
    payroll = models.ForeignKey(PayrollEntry, on_delete=models.CASCADE, related_name="additional_lines")
    employee_type = models.CharField(max_length=30)
    label = models.CharField(max_length=200)
    amount = models.DecimalField(**MONEY)
    sort_order = models.PositiveIntegerField(default=0)


class BillingStatement(models.Model):
    class Status(models.TextChoices):
        OPEN = "Open", "Open"
        PARTIAL = "Partially Paid", "Partially Paid"
        PAID = "Paid", "Paid"

    billing_no = models.CharField(max_length=50, unique=True)
    client = models.ForeignKey(Client, on_delete=models.PROTECT, related_name="billing_statements")
    billing_date = models.DateField(db_index=True)
    period_from = models.DateField(null=True, blank=True)
    period_to = models.DateField(null=True, blank=True)
    base_charges_total = models.DecimalField(**MONEY)
    extra_charges_total = models.DecimalField(**MONEY)
    gross_total = models.DecimalField(**MONEY)
    vat_enabled = models.BooleanField(default=False)
    vat_amount = models.DecimalField(**MONEY)
    additions_total = models.DecimalField(**MONEY)
    deductions_total = models.DecimalField(**MONEY)
    grand_total = models.DecimalField(**MONEY)
    status = models.CharField(max_length=30, choices=Status.choices, default=Status.OPEN, db_index=True)
    notes = models.TextField(blank=True)

    def __str__(self):
        return self.billing_no


class BillingLine(models.Model):
    billing = models.ForeignKey(BillingStatement, on_delete=models.CASCADE, related_name="lines")
    trip = models.OneToOneField(Trip, on_delete=models.PROTECT, related_name="billing_line")
    amount_base = models.DecimalField(**MONEY)
    amount_extra = models.DecimalField(**MONEY)
    amount_total = models.DecimalField(**MONEY)


class BillingAdjustment(models.Model):
    class LineType(models.TextChoices):
        ADDITION = "Addition", "Addition"
        DEDUCTION = "Deduction", "Deduction"

    billing = models.ForeignKey(BillingStatement, on_delete=models.CASCADE, related_name="adjustments")
    line_type = models.CharField(max_length=20, choices=LineType.choices)
    label = models.CharField(max_length=200)
    amount = models.DecimalField(**MONEY)
    sort_order = models.PositiveIntegerField(default=0)


class Collection(models.Model):
    collection_date = models.DateField(db_index=True)
    client = models.ForeignKey(Client, null=True, blank=True, on_delete=models.PROTECT, related_name="collections")
    billing = models.ForeignKey(BillingStatement, null=True, blank=True, on_delete=models.PROTECT, related_name="collections")
    amount_paid = models.DecimalField(**MONEY)
    reference_no = models.CharField(max_length=100, blank=True)
    payment_method = models.CharField(max_length=100, blank=True)
    notes = models.TextField(blank=True)

    def __str__(self):
        return self.reference_no or f"Collection #{self.pk}"
