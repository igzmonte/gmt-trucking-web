from datetime import date
from decimal import Decimal

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from core.models import (
    Asset,
    BillingLine,
    BillingStatement,
    Client,
    Collection,
    Employee,
    Supplier,
    Trip,
)


class Command(BaseCommand):
    help = "Seed a new hosted database with deterministic, synthetic preview data"

    @transaction.atomic
    def handle(self, *args, **options):
        model_counts = {
            "employees": Employee.objects.count(),
            "assets": Asset.objects.count(),
            "clients": Client.objects.count(),
            "suppliers": Supplier.objects.count(),
            "trips": Trip.objects.count(),
        }
        if any(model_counts.values()):
            if all(model_counts.values()):
                self.stdout.write("Domain data already exists; hosted preview seed skipped.")
                return
            raise CommandError(f"Database is partially initialized; refusing to seed: {model_counts}")

        driver = Employee.objects.create(
            employee_code="EMP-001",
            full_name="Sample Driver One",
            employee_type=Employee.Type.DRIVER,
            employment_status=Employee.Status.ACTIVE,
            payroll_basis=Employee.PayrollBasis.PER_TRIP,
            trip_rate=Decimal("850.00"),
        )
        Employee.objects.create(
            employee_code="EMP-002",
            full_name="Sample Helper One",
            employee_type=Employee.Type.HELPER,
            employment_status=Employee.Status.ACTIVE,
            payroll_basis=Employee.PayrollBasis.PER_TRIP,
            trip_rate=Decimal("450.00"),
        )
        client = Client.objects.create(
            client_code="CLI-001",
            client_name="Sample Client Corporation",
            billing_address="100 Example Avenue, Sample City",
            contact_person="Sample Contact",
            contact_no="+63 900 000 0000",
        )
        Supplier.objects.create(
            supplier_name="Sample Parts Supplier",
            contact_person="Sample Supplier Contact",
            contact_no="+63 900 000 0001",
            address="200 Example Road, Sample City",
        )
        asset = Asset.objects.create(
            asset_code="TRK-001",
            asset_type=Asset.Type.CARGO,
            plate_no="SAMPLE-01",
            make_model="Sample Cargo Truck",
            status=Asset.Status.IN_USE,
            assigned_employee=driver,
        )
        Trip.objects.create(
            trip_ticket_no="TT-2026-0001",
            trip_type=Trip.Type.SPOT,
            trip_date=date(2026, 1, 15),
            client=client,
            asset=asset,
            driver=driver,
            origin="Sample Warehouse",
            destination="Sample Delivery Hub",
            job_description="Synthetic hosted preview delivery",
            status=Trip.Status.ONGOING,
            base_trip_rate=Decimal("12500.00"),
        )
        completed = Trip.objects.create(
            trip_ticket_no="TT-2026-0002",
            trip_type=Trip.Type.SPOT,
            trip_date=date(2026, 1, 14),
            client=client,
            asset=asset,
            driver=driver,
            origin="Sample Port",
            destination="Sample Depot",
            job_description="Synthetic completed delivery",
            status=Trip.Status.COMPLETED,
            base_trip_rate=Decimal("10000.00"),
        )
        billed = Trip.objects.create(
            trip_ticket_no="TT-2026-0003",
            trip_type=Trip.Type.SPOT,
            trip_date=date(2026, 1, 10),
            client=client,
            asset=asset,
            driver=driver,
            origin="Sample Depot",
            destination="Sample Customer Site",
            job_description="Synthetic billed delivery",
            status=Trip.Status.BILLED,
            base_trip_rate=Decimal("15000.00"),
        )
        billing = BillingStatement.objects.create(
            billing_no="BILL-2026-0001",
            client=client,
            billing_date=date(2026, 1, 12),
            period_from=date(2026, 1, 1),
            period_to=date(2026, 1, 15),
            base_charges_total=Decimal("15000.00"),
            gross_total=Decimal("15000.00"),
            grand_total=Decimal("15000.00"),
            status=BillingStatement.Status.PARTIAL,
            notes="Synthetic hosted preview billing",
        )
        BillingLine.objects.create(
            billing=billing,
            trip=billed,
            amount_base=Decimal("15000.00"),
            amount_total=Decimal("15000.00"),
        )
        Collection.objects.create(
            collection_date=date(2026, 1, 20),
            client=client,
            billing=billing,
            amount_paid=Decimal("5000.00"),
            reference_no="SAMPLE-RECEIPT-001",
            payment_method="Bank Transfer",
        )
        self.stdout.write(
            self.style.SUCCESS(
                f"Synthetic hosted preview seeded ({Employee.objects.count()} employees, "
                f"{Trip.objects.count()} trips)."
            )
        )
