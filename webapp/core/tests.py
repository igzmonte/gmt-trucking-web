from io import StringIO
from pathlib import Path
from unittest import skipUnless
from decimal import Decimal
from datetime import date
import json
import csv

from django.contrib.auth.models import Group, User
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import Client as TestClient, TestCase
from django.urls import reverse
from .access import can_edit, can_view
from .forms import TripForm
from .models import Asset, BillingAdjustment, BillingLine, BillingStatement, CashAdvance, Client, Collection, Employee, Payable, PayrollAdditionalLine, PayrollEntry, PayrollTrip, RecurringTripMaster, Repair, Supplier, Trip, TripEmployeePayItem, TripHelper, ValeRecord
from .payroll_services import create_payroll, payroll_preview
from .billing_services import create_billing, eligible_billing_trips
from .templatetags.accounting import accounting
from .report_services import REPORTS, build_report
from .services import dashboard_snapshot, next_trip_ticket_no

FIXTURE = Path(__file__).resolve().parents[2] / "tests" / "characterization" / "artifacts" / "gmt_characterization.sqlite3"

class AccessTests(TestCase):
    def setUp(self):
        self.users = {}
        for role in ("admin", "encoder", "viewer", "accounting"):
            group = Group.objects.create(name=role)
            user = User.objects.create_user(f"test_{role}", password="test")
            user.groups.add(group)
            self.users[role] = user

    def test_role_matrix(self):
        assert can_view(self.users["viewer"], "Reports")
        assert not can_edit(self.users["viewer"], "Reports")
        assert can_edit(self.users["accounting"], "Payroll")
        assert not can_view(self.users["encoder"], "Payroll")

    def test_dashboard_requires_login(self):
        response = self.client.get(reverse("dashboard"))
        self.assertEqual(response.status_code, 302)

    def test_accounting_dashboard(self):
        self.client.force_login(self.users["accounting"])
        response = self.client.get(reverse("dashboard"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "data-sidebar-scroll-controls")


class UserManagementTests(TestCase):
    def setUp(self):
        self.groups = {role: Group.objects.create(name=role) for role in ("admin", "encoder", "viewer", "accounting")}
        self.admin = User.objects.create_user("user_admin", password="admin-password-123", email="admin@example.com", is_active=True)
        self.admin.groups.add(self.groups["admin"])
        self.second_admin = User.objects.create_user("second_admin", password="admin-password-123", is_active=True)
        self.second_admin.groups.add(self.groups["admin"])
        self.encoder = User.objects.create_user("user_encoder", password="encoder-password-123", is_active=True)
        self.encoder.groups.add(self.groups["encoder"])
        self.viewer = User.objects.create_user("user_viewer", password="viewer-password-123", is_active=True)
        self.viewer.groups.add(self.groups["viewer"])
        self.accounting = User.objects.create_user("user_accounting", password="accounting-password-123", is_active=True)
        self.accounting.groups.add(self.groups["accounting"])

    def user_payload(self, **overrides):
        payload = {
            "username": "new_encoder", "first_name": "New", "last_name": "Encoder",
            "email": "new@example.com", "role": "encoder", "is_active": "on",
            "password": "safe-password-123",
        }
        payload.update(overrides)
        return payload

    def test_admin_only_navigation_and_permissions(self):
        for user, expected in ((self.admin, 200), (self.encoder, 403), (self.viewer, 403), (self.accounting, 403)):
            self.client.force_login(user)
            self.assertEqual(self.client.get(reverse("users_list")).status_code, expected)
        self.client.force_login(self.admin)
        self.assertContains(self.client.get("/"), "User Management")
        self.client.force_login(self.accounting)
        self.assertNotContains(self.client.get("/"), "User Management")

    def test_create_edit_password_role_access_and_export(self):
        self.client.force_login(self.admin)
        response = self.client.post(reverse("users_new"), self.user_payload())
        created = User.objects.get(username="new_encoder")
        self.assertRedirects(response, reverse("users_list"))
        self.assertEqual(created.groups.get().name, "encoder")
        self.assertTrue(created.is_active)
        self.assertTrue(created.check_password("safe-password-123"))
        self.client.force_login(created)
        self.assertEqual(self.client.get(reverse("billing_list")).status_code, 403)
        self.client.force_login(self.admin)
        self.client.post(reverse("users_edit", args=[created.pk]), self.user_payload(username="new_encoder", role="accounting", password="", email="changed@example.com"))
        created.refresh_from_db()
        self.assertEqual(created.groups.get().name, "accounting")
        self.assertEqual(created.email, "changed@example.com")
        self.assertTrue(created.check_password("safe-password-123"))
        self.client.force_login(created)
        self.assertEqual(self.client.get(reverse("billing_list")).status_code, 200)
        self.client.force_login(self.admin)
        self.client.post(reverse("users_password", args=[created.pk]), {"password": "new-safe-password-123", "confirm_password": "new-safe-password-123"})
        created.refresh_from_db()
        self.assertFalse(created.check_password("safe-password-123"))
        self.assertTrue(created.check_password("new-safe-password-123"))
        self.client.force_login(self.admin)
        exported = self.client.get(reverse("users_export")).content.decode()
        self.assertIn("new_encoder", exported)
        self.assertNotIn("pbkdf2", exported)
        self.assertNotIn("safe-password", exported)

    def test_deactivation_safety_rules_and_csrf(self):
        self.client.force_login(self.admin)
        response = self.client.post(reverse("users_deactivate", args=[self.admin.pk]), follow=True)
        self.assertContains(response, "cannot deactivate your own account")
        self.admin.refresh_from_db()
        self.assertTrue(self.admin.is_active)
        self.client.post(reverse("users_deactivate", args=[self.second_admin.pk]), follow=True)
        self.second_admin.refresh_from_db()
        self.assertFalse(self.second_admin.is_active)
        response = self.client.post(reverse("users_edit", args=[self.admin.pk]), {
            "username": self.admin.username, "first_name": "", "last_name": "", "email": self.admin.email,
            "role": "viewer", "is_active": "on",
        })
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "At least one active admin must remain")
        self.admin.refresh_from_db()
        self.assertEqual(self.admin.groups.get().name, "admin")
        csrf_client = TestClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.admin)
        self.assertEqual(csrf_client.post(reverse("users_new"), self.user_payload()).status_code, 403)


class BaselineDashboardTests(TestCase):
    def test_snapshot_shape(self):
        snapshot = dashboard_snapshot()
        self.assertEqual(set(snapshot), {"metrics", "trips", "billings"})
        self.assertEqual(set(snapshot["metrics"]), {"ongoing", "unbilled", "receivables", "advances"})

    def test_health_checks_database(self):
        response = self.client.get(reverse("health"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})


@skipUnless(FIXTURE.is_file(), "Local sanitized SQLite fixture is intentionally excluded from GitHub")
class LegacyImportTests(TestCase):
    def test_dry_run_rolls_back(self):
        out = StringIO()
        call_command("import_legacy", source=FIXTURE, dry_run=True, stdout=out)
        self.assertEqual(Employee.objects.count(), 0)
        self.assertIn("rolled back", out.getvalue())

    def test_full_import_normalizes_and_authenticates(self):
        call_command("import_legacy", source=FIXTURE, stdout=StringIO())
        self.assertEqual(Employee.objects.count(), 30)
        self.assertEqual(Asset.objects.count(), 18)
        self.assertEqual(Client.objects.count(), 16)
        self.assertEqual(Supplier.objects.count(), 4)
        self.assertEqual(Trip.objects.count(), 95)
        self.assertEqual(TripHelper.objects.count(), 92)
        self.assertEqual(PayrollTrip.objects.count(), 98)
        self.assertEqual(PayrollEntry.objects.count(), 27)
        self.assertEqual(BillingStatement.objects.count(), 3)
        self.assertEqual(BillingLine.objects.count(), 17)
        self.assertEqual(Collection.objects.count(), 0)
        self.assertEqual(Trip.objects.exclude(reference_no="").count(), 0)
        self.assertEqual(ValeRecord.objects.count(), 2)
        self.assertEqual(CashAdvance.objects.count(), 0)
        self.assertEqual(Trip.objects.filter(pk__in=[25, 35, 36, 37], recurring_master__isnull=True).count(), 4)
        imported = User.objects.get(username="test_admin")
        self.assertTrue(imported.password.startswith("legacy_sha256$"))

    def test_skip_users_does_not_import_legacy_credentials(self):
        User.objects.create_user("hosted_admin", password="safe-test-password")
        call_command("import_legacy", source=FIXTURE, skip_users=True, stdout=StringIO())
        self.assertEqual(list(User.objects.values_list("username", flat=True)), ["hosted_admin"])
        self.assertEqual(Employee.objects.count(), 30)


class HostedBootstrapTests(TestCase):
    def test_bootstrap_requires_secrets(self):
        with self.assertRaises(CommandError):
            call_command("bootstrap_hosted", stdout=StringIO())

    def test_bootstrap_and_preview_seed_are_idempotent(self):
        with self.settings():
            from unittest.mock import patch
            environment = {
                "GMT_ADMIN_USERNAME": "hosted_admin",
                "GMT_ADMIN_PASSWORD": "safe-test-password",
                "GMT_ADMIN_EMAIL": "admin@example.invalid",
                "GMT_PREVIEW_ROLE_PASSWORD": "preview-test-password",
            }
            with patch.dict("os.environ", environment, clear=False):
                call_command("bootstrap_hosted", stdout=StringIO())
                call_command("bootstrap_hosted", stdout=StringIO())
        call_command("seed_hosted_preview", stdout=StringIO())
        call_command("seed_hosted_preview", stdout=StringIO())
        self.assertEqual(User.objects.filter(username="hosted_admin", is_superuser=True).count(), 1)
        self.assertEqual(
            set(User.objects.filter(username__startswith="preview_").values_list("username", flat=True)),
            {"preview_encoder", "preview_viewer", "preview_accounting"},
        )
        self.assertEqual(Employee.objects.count(), 2)
        self.assertEqual(Trip.objects.count(), 3)


class MasterDataTests(TestCase):
    def setUp(self):
        self.users = {}
        for role in ("admin", "encoder", "viewer", "accounting"):
            group = Group.objects.create(name=role)
            user = User.objects.create_user(f"master_{role}", password="test")
            user.groups.add(group)
            self.users[role] = user
        self.employee = Employee.objects.create(employee_code="E-1", full_name="Example Employee", employee_type="Driver", employment_status="Active", payroll_basis="Per Trip")
        self.client_record = Client.objects.create(client_code="C-1", client_name="Example Client")

    def test_permissions(self):
        for role, expected in (("admin", 200), ("encoder", 200), ("viewer", 200), ("accounting", 403)):
            self.client.force_login(self.users[role])
            self.assertEqual(self.client.get(reverse("employees_list")).status_code, expected)
        self.client.force_login(self.users["viewer"])
        self.assertEqual(self.client.get(reverse("employees_new")).status_code, 403)
        self.assertEqual(self.client.post(reverse("employees_list"), {}).status_code, 403)

    def test_create_search_pagination_and_csv(self):
        self.client.force_login(self.users["encoder"])
        response = self.client.post(reverse("clients_new"), {"client_code": "C-2", "client_name": "Second Client", "terms_days": 30, "active": "on"})
        self.assertRedirects(response, reverse("clients_list"))
        self.assertTrue(Client.objects.filter(client_code="C-2").exists())
        self.assertContains(self.client.get(reverse("clients_list") + "?q=Second"), "Second Client")
        response = self.client.get(reverse("clients_export"))
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response["Content-Type"].startswith("text/csv"))
        for i in range(26):
            Supplier.objects.create(supplier_name=f"Supplier {i:02d}")
        page = self.client.get(reverse("suppliers_list"))
        self.assertContains(page, "Page 1 of 2")

    def test_create_modal_and_inline_validation(self):
        self.client.force_login(self.users["encoder"])
        response = self.client.get(reverse("employees_list"))
        self.assertContains(response, 'id="create-record-dialog"')
        self.assertContains(response, 'data-dialog-open="create-record-dialog"')

        response = self.client.post(reverse("clients_list"), {
            "client_code": "C-1",
            "client_name": "Example Client",
            "terms_days": 30,
            "active": "on",
        })
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "data-open-on-load")
        self.assertContains(response, "already exists")

        response = self.client.post(reverse("clients_list"), {
            "client_code": "C-MODAL",
            "client_name": "Created In Modal",
            "terms_days": 30,
            "active": "on",
        })
        self.assertRedirects(response, reverse("clients_list"))
        self.assertTrue(Client.objects.filter(client_code="C-MODAL").exists())

    def test_protected_delete_and_csrf(self):
        Trip.objects.create(trip_ticket_no="TT-TEST-999999", trip_type="Spot Trip", trip_date="2026-01-01", client=self.client_record)
        self.client.force_login(self.users["admin"])
        self.client.post(reverse("clients_delete", args=[self.client_record.pk]))
        self.assertTrue(Client.objects.filter(pk=self.client_record.pk).exists())
        csrf_client = TestClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.users["admin"])
        self.assertEqual(csrf_client.post(reverse("employees_delete", args=[self.employee.pk])).status_code, 403)
        self.assertEqual(csrf_client.post(reverse("employees_list"), {"full_name": "No CSRF"}).status_code, 403)


class TripOperationsTests(TestCase):
    def setUp(self):
        self.users = {}
        for role in ("admin", "encoder", "viewer", "accounting"):
            group = Group.objects.create(name=f"trip_{role}")
            # Access roles use their canonical group names.
            group.name = role
            group.save()
            user = User.objects.create_user(f"trip_{role}", password="test")
            user.groups.add(group)
            self.users[role] = user
        self.client_record = Client.objects.create(client_code="TRIP-C", client_name="Trip Client")
        self.driver = Employee.objects.create(employee_code="TRIP-D", full_name="Trip Driver", employee_type="Driver", employment_status="Active", payroll_basis="Per Trip")
        self.helpers = [
            Employee.objects.create(employee_code=f"TRIP-H{i}", full_name=f"Trip Helper {i}", employee_type="Helper", employment_status="Active", payroll_basis="Per Trip")
            for i in range(1, 4)
        ]
        self.small = Asset.objects.create(asset_code="SMALL-1", asset_type=Asset.Type.SMALL)
        self.trailer = Asset.objects.create(asset_code="TRAILER-1", asset_type=Asset.Type.TRAILER)
        self.master = RecurringTripMaster.objects.create(
            master_code="RM-001", client=self.client_record, job_description="Recurring delivery",
            origin="Warehouse", destination="Depot", default_asset=self.trailer,
            default_driver=self.driver, default_helper_count=2, standard_base_rate="10000.00",
            driver_pay_rate="1000.00", helper_pay_rate="600.00", active=True,
        )

    def trip_payload(self, **overrides):
        payload = {
            "trip_ticket_no": "", "trip_type": Trip.Type.SPOT, "recurring_master": "",
            "reference_no": "CLIENT-REF-001",
            "trip_date": "2026-07-04", "client": self.client_record.pk,
            "job_description": "Delivery", "origin": "Origin", "destination": "Destination",
            "asset": self.trailer.pk, "driver": self.driver.pk,
            "helper_1": "", "helper_2": "", "helper_3": "",
            "dispatch_time": "08:00", "arrival_time": "10:00", "status": Trip.Status.PLANNED,
            "base_trip_rate": "10000.00", "driver_pay_rate": "1000.00", "helper_pay_rate": "600.00",
            "fuel_surcharge": "500.00", "loading_fee": "100.00", "unloading_fee": "100.00",
            "waiting_fee": "0.00", "tolls": "50.00", "additional_stop_charge": "0.00",
            "special_handling_fee": "0.00", "other_charges": "25.00", "notes": "",
        }
        payload.update(overrides)
        return payload

    def test_routes_permissions_and_modal(self):
        for role, expected in (("admin", 200), ("encoder", 200), ("viewer", 200), ("accounting", 403)):
            self.client.force_login(self.users[role])
            self.assertEqual(self.client.get(reverse("trips_list")).status_code, expected)
            self.assertEqual(self.client.get(reverse("recurring_trips_list")).status_code, expected)
        self.client.force_login(self.users["viewer"])
        self.assertEqual(self.client.post(reverse("trips_new"), self.trip_payload()).status_code, 403)
        viewer_list = self.client.get(reverse("trips_list"))
        self.assertNotContains(viewer_list, "New Trip Details")
        self.client.force_login(self.users["encoder"])
        response = self.client.get(reverse("trips_list"))
        self.assertNotContains(response, 'id="trip-create-dialog"')
        self.assertContains(response, reverse("trips_new"))
        self.assertContains(response, "New Trip Details")
        new_page = self.client.get(reverse("trips_new"))
        self.assertEqual(new_page.status_code, 200)
        self.assertContains(new_page, "RM-001")
        self.assertContains(new_page, 'class="trip-section-grid"')
        self.assertContains(new_page, "Employee Pay Rates")
        self.assertContains(new_page, "Trip / Unit Charges")
        for field_name in (
            "trip_ticket_no", "reference_no", "trip_date", "trip_type", "recurring_master", "status",
            "client", "job_description", "origin", "destination", "dispatch_time", "arrival_time",
            "asset", "driver", "helper_1", "helper_2", "helper_3", "base_trip_rate",
            "driver_pay_rate", "helper_pay_rate", "fuel_surcharge", "loading_fee",
            "unloading_fee", "waiting_fee", "tolls", "additional_stop_charge",
            "special_handling_fee", "other_charges", "notes",
        ):
            self.assertContains(new_page, f'name="{field_name}"')

    def test_recurring_create_search_export_and_delete_snapshot(self):
        self.client.force_login(self.users["encoder"])
        response = self.client.post(reverse("recurring_trips_list"), {
            "master_code": "RM-NEW", "client": self.client_record.pk,
            "job_description": "New recurring route", "origin": "A", "destination": "B",
            "default_asset": self.small.pk, "default_driver": self.driver.pk,
            "default_helper_count": 1, "standard_base_rate": "5000.00",
            "driver_pay_rate": "500.00", "helper_pay_rate": "250.00", "active": "on",
        })
        self.assertRedirects(response, reverse("recurring_trips_list"))
        created = RecurringTripMaster.objects.get(master_code="RM-NEW")
        self.assertContains(self.client.get(reverse("recurring_trips_list") + "?q=RM-NEW"), "RM-NEW")
        self.assertEqual(self.client.get(reverse("recurring_trips_export")).status_code, 200)
        trip = Trip.objects.create(trip_ticket_no="TT-2026-999991", trip_type=Trip.Type.RECURRING, recurring_master=created, trip_date="2026-07-04", client=self.client_record)
        self.client.post(reverse("recurring_trips_delete", args=[created.pk]))
        trip.refresh_from_db()
        self.assertIsNone(trip.recurring_master_id)

    def test_trip_create_number_helpers_and_totals(self):
        self.client.force_login(self.users["encoder"])
        response = self.client.post(reverse("trips_new"), self.trip_payload(
            helper_1=self.helpers[1].pk, helper_2=self.helpers[0].pk,
        ))
        trip = Trip.objects.get(job_description="Delivery")
        self.assertRedirects(response, reverse("trips_detail", args=[trip.pk]))
        self.assertEqual(trip.trip_ticket_no, "TT-2026-000001")
        self.assertEqual(trip.reference_no, "CLIENT-REF-001")
        self.assertEqual(list(trip.helper_assignments.values_list("employee_id", flat=True)), [self.helpers[1].pk, self.helpers[0].pk])
        self.assertEqual(trip.extra_total, 775)
        self.assertEqual(trip.billable_total, 10775)
        self.assertIn("10775", self.client.get(reverse("trips_export")).content.decode())
        self.assertIn("CLIENT-REF-001", self.client.get(reverse("trips_export")).content.decode())
        self.assertContains(self.client.get(reverse("trips_list") + "?q=CLIENT-REF-001"), "CLIENT-REF-001")
        self.assertEqual(next_trip_ticket_no(trip.trip_date), "TT-2026-000002")

    def test_labeled_pay_items_and_printable_ticket(self):
        self.client.force_login(self.users["encoder"])
        response = self.client.post(reverse("trips_new"), self.trip_payload(
            trip_ticket_no="TT-2026-000099",
            helper_1=self.helpers[0].pk,
            driver_pay_items='[{"label":"Night Shift","amount":"150.00"}]',
            helper_pay_items='[{"label":"Heavy Load","amount":"200.00"}]',
        ))
        trip = Trip.objects.get(trip_ticket_no="TT-2026-000099")
        self.assertRedirects(response, reverse("trips_detail", args=[trip.pk]))
        self.assertEqual(trip.driver_additional_pay, 150)
        self.assertEqual(trip.helper_additional_pay, 200)
        self.assertEqual(list(trip.employee_pay_items.values_list("employee_type", "label", "amount")), [
            ("Driver", "Night Shift", trip.driver_additional_pay),
            ("Helper", "Heavy Load", trip.helper_additional_pay),
        ])
        ticket = self.client.get(reverse("trips_print", args=[trip.pk]))
        self.assertContains(ticket, "Trip Ticket / Waybill")
        self.assertContains(ticket, "Item / Job")
        self.assertContains(ticket, "Night Shift")
        self.assertContains(ticket, self.helpers[0].full_name)
        detail = self.client.get(reverse("trips_detail", args=[trip.pk]))
        self.assertContains(detail, "Route &amp; Schedule")
        self.assertContains(detail, "Item / Job")
        self.assertContains(detail, "Night Shift")

    def test_recurring_master_required_and_helper_limits(self):
        recurring = TripForm(data=self.trip_payload(trip_type=Trip.Type.RECURRING, recurring_master=""))
        self.assertFalse(recurring.is_valid())
        self.assertIn("recurring_master", recurring.errors)
        limited = TripForm(data=self.trip_payload(asset=self.small.pk, helper_1=self.helpers[0].pk, helper_2=self.helpers[1].pk))
        self.assertFalse(limited.is_valid())
        self.assertIn("asset", limited.errors)
        duplicate = TripForm(data=self.trip_payload(helper_1=self.helpers[0].pk, helper_2=self.helpers[0].pk))
        self.assertFalse(duplicate.is_valid())
        self.assertIn("Helper selections must be unique", str(duplicate.non_field_errors()))

    def test_trip_delete_is_protected_by_billing(self):
        trip = Trip.objects.create(trip_ticket_no="TT-2026-999992", trip_type=Trip.Type.SPOT, trip_date="2026-07-04", client=self.client_record)
        billing = BillingStatement.objects.create(billing_no="BILL-PROTECT", client=self.client_record, billing_date="2026-07-04")
        BillingLine.objects.create(billing=billing, trip=trip)
        self.client.force_login(self.users["admin"])
        response = self.client.post(reverse("trips_delete", args=[trip.pk]), follow=True)
        self.assertContains(response, "cannot be deleted")
        self.assertTrue(Trip.objects.filter(pk=trip.pk).exists())


class RepairsPayablesTests(TestCase):
    def setUp(self):
        self.users = {}
        for role in ("admin", "encoder", "viewer", "accounting"):
            group, _ = Group.objects.get_or_create(name=role)
            user = User.objects.create_user(f"maintenance_{role}", password="test")
            user.groups.add(group)
            self.users[role] = user
        self.asset = Asset.objects.create(asset_code="R-TRUCK-1", asset_type=Asset.Type.CARGO)
        self.supplier = Supplier.objects.create(supplier_name="Repair Supplier")

    def repair_payload(self, **overrides):
        payload = {
            "repair_date": "2026-07-04", "asset": self.asset.pk,
            "repair_description": "Replace brake assembly", "meter_value": "125000",
            "supplier": self.supplier.pk, "parts_cost": "2500.25", "labor_cost": "750.50",
            "other_cost": "49.25", "total_cost": "1.00", "status": Repair.Status.OPEN,
            "notes": "Workshop snapshot", "auto_generate_payable": "on",
        }
        payload.update(overrides)
        return payload

    def payable_payload(self, **overrides):
        payload = {
            "payable_date": "2026-07-04", "supplier": self.supplier.pk,
            "source_type": "Manual", "reference_no": "MAN-001",
            "description": "Manual obligation", "amount": "1200.00",
            "due_date": "2026-07-20", "status": Payable.Status.OPEN, "notes": "Manual note",
        }
        payload.update(overrides)
        return payload

    def test_role_permissions_and_navigation(self):
        repair_access = {"admin": 200, "encoder": 200, "viewer": 200, "accounting": 403}
        payable_access = {"admin": 200, "encoder": 403, "viewer": 200, "accounting": 200}
        for role in self.users:
            self.client.force_login(self.users[role])
            self.assertEqual(self.client.get(reverse("repairs_list")).status_code, repair_access[role])
            self.assertEqual(self.client.get(reverse("payables_list")).status_code, payable_access[role])
        self.client.force_login(self.users["viewer"])
        self.assertEqual(self.client.get(reverse("repairs_new")).status_code, 403)
        self.assertEqual(self.client.get(reverse("payables_new")).status_code, 403)
        self.assertNotContains(self.client.get(reverse("repairs_list")), "New Repair Details")
        self.client.force_login(self.users["encoder"])
        self.assertContains(self.client.get(reverse("repairs_list")), "New Repair Details")
        self.client.force_login(self.users["accounting"])
        self.assertContains(self.client.get(reverse("payables_list")), "New Payable Details")

    def test_repair_total_and_generated_payable_snapshot(self):
        self.client.force_login(self.users["encoder"])
        response = self.client.post(reverse("repairs_new"), self.repair_payload())
        repair = Repair.objects.get()
        self.assertRedirects(response, reverse("repairs_detail", args=[repair.pk]))
        self.assertEqual(repair.total_cost, Decimal("3300.00"))
        payable = repair.generated_payable
        self.assertEqual(payable.reference_no, f"REP-{repair.pk:05d}")
        self.assertEqual(payable.amount, Decimal("3300.00"))
        self.assertEqual(payable.due_date, repair.repair_date)
        self.assertEqual(payable.source_type, "Repair")
        self.assertEqual(payable.status, Payable.Status.OPEN)

        response = self.client.post(reverse("repairs_edit", args=[repair.pk]), self.repair_payload(
            repair_description="Updated repair", parts_cost="9000.00", notes="Updated note"
        ))
        self.assertRedirects(response, reverse("repairs_detail", args=[repair.pk]))
        payable.refresh_from_db()
        self.assertEqual(payable.amount, Decimal("3300.00"))
        self.assertEqual(payable.description, "Replace brake assembly")
        self.assertEqual(Payable.objects.filter(linked_repair=repair).count(), 1)

    def test_enabling_auto_generation_later_creates_once(self):
        self.client.force_login(self.users["encoder"])
        payload = self.repair_payload(auto_generate_payable="")
        self.client.post(reverse("repairs_new"), payload)
        repair = Repair.objects.get()
        self.assertFalse(Payable.objects.exists())
        payload["auto_generate_payable"] = "on"
        self.client.post(reverse("repairs_edit", args=[repair.pk]), payload)
        self.client.post(reverse("repairs_edit", args=[repair.pk]), payload)
        self.assertEqual(Payable.objects.filter(linked_repair=repair).count(), 1)

    def test_guarded_repair_delete_and_payable_unlink(self):
        repair = Repair.objects.create(repair_date="2026-07-04", asset=self.asset, repair_description="Linked", supplier=self.supplier, parts_cost=1, labor_cost=2, other_cost=3, total_cost=6, auto_generate_payable=True)
        payable = Payable.objects.create(payable_date="2026-07-04", supplier=self.supplier, source_type="Repair", reference_no="REP-LINK", amount=6, linked_repair=repair)
        self.client.force_login(self.users["admin"])
        response = self.client.post(reverse("repairs_delete", args=[repair.pk]), follow=True)
        self.assertContains(response, "cannot be deleted")
        self.assertTrue(Repair.objects.filter(pk=repair.pk).exists())
        self.client.post(reverse("payables_delete", args=[payable.pk]))
        self.assertTrue(Repair.objects.filter(pk=repair.pk).exists())
        self.client.post(reverse("repairs_delete", args=[repair.pk]))
        self.assertFalse(Repair.objects.filter(pk=repair.pk).exists())

    def test_manual_payable_search_edit_export_and_details(self):
        self.client.force_login(self.users["accounting"])
        response = self.client.post(reverse("payables_new"), self.payable_payload())
        payable = Payable.objects.get(reference_no="MAN-001")
        self.assertRedirects(response, reverse("payables_detail", args=[payable.pk]))
        self.assertContains(self.client.get(reverse("payables_list") + "?q=MAN-001"), "Manual obligation")
        self.assertContains(self.client.get(reverse("payables_detail", args=[payable.pk])), "1200.00")
        response = self.client.post(reverse("payables_edit", args=[payable.pk]), self.payable_payload(status=Payable.Status.PARTIAL))
        self.assertRedirects(response, reverse("payables_detail", args=[payable.pk]))
        payable.refresh_from_db()
        self.assertEqual(payable.status, Payable.Status.PARTIAL)
        export = self.client.get(reverse("payables_export"))
        self.assertEqual(export.status_code, 200)
        self.assertIn("MAN-001", export.content.decode())

    def test_validation_and_csrf(self):
        self.client.force_login(self.users["encoder"])
        response = self.client.post(reverse("repairs_new"), self.repair_payload(parts_cost="-1"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Amount cannot be negative")
        csrf_client = TestClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.users["admin"])
        self.assertEqual(csrf_client.post(reverse("repairs_new"), self.repair_payload()).status_code, 403)


class AdvanceOperationsTests(TestCase):
    def setUp(self):
        self.users = {}
        for role in ("admin", "encoder", "viewer", "accounting"):
            group, _ = Group.objects.get_or_create(name=role)
            user = User.objects.create_user(f"advance_{role}", password="test")
            user.groups.add(group)
            self.users[role] = user
        self.employee = Employee.objects.create(
            employee_code="ADV-EMP", full_name="Advance Employee", employee_type="Driver",
            employment_status="Active", payroll_basis="Per Trip", active=True,
        )

    def vale_payload(self, **overrides):
        payload = {"employee": self.employee.pk, "date_granted": "2026-07-04", "amount": "3000.00", "installment_amount": "500.00", "notes": "Payroll installment"}
        payload.update(overrides)
        return payload

    def cash_payload(self, **overrides):
        payload = {"employee": self.employee.pk, "date_granted": "2026-07-04", "amount": "1000.00", "notes": "Next payroll"}
        payload.update(overrides)
        return payload

    def test_permissions_sidebar_and_maintenance_group(self):
        for role, expected in (("admin", 200), ("encoder", 200), ("viewer", 200), ("accounting", 403)):
            self.client.force_login(self.users[role])
            self.assertEqual(self.client.get(reverse("advances_list")).status_code, expected)
        self.client.force_login(self.users["viewer"])
        self.assertEqual(self.client.get(reverse("vale_new")).status_code, 403)
        self.assertEqual(self.client.get(reverse("cash_advance_new")).status_code, 403)
        self.client.force_login(self.users["encoder"])
        page = self.client.get(reverse("advances_list"))
        self.assertContains(page, "New Vale")
        self.assertContains(page, "New Cash Advance")
        self.assertContains(page, "Maintenance")

    def test_create_vale_opening_balance_and_detail(self):
        self.client.force_login(self.users["encoder"])
        response = self.client.post(reverse("vale_new"), self.vale_payload())
        record = ValeRecord.objects.get()
        self.assertRedirects(response, reverse("vale_detail", args=[record.pk]))
        self.assertEqual(record.amount, Decimal("3000.00"))
        self.assertEqual(record.balance, Decimal("3000.00"))
        self.assertEqual(record.installment_amount, Decimal("500.00"))
        self.assertEqual(record.status, "Open")
        self.assertContains(self.client.get(reverse("vale_detail", args=[record.pk])), "Advance Employee")

    def test_create_cash_advance_opening_balance(self):
        self.client.force_login(self.users["encoder"])
        response = self.client.post(reverse("cash_advance_new"), self.cash_payload())
        record = CashAdvance.objects.get()
        self.assertRedirects(response, reverse("cash_advance_detail", args=[record.pk]))
        self.assertEqual(record.balance, Decimal("1000.00"))
        self.assertFalse(record.applied)
        self.assertEqual(record.status, "Open")

    def test_edit_preserves_payroll_controlled_balance(self):
        vale = ValeRecord.objects.create(employee=self.employee, date_granted="2026-07-04", amount=3000, installment_amount=500, balance=2500, status="Open")
        cash = CashAdvance.objects.create(employee=self.employee, date_granted="2026-07-04", amount=1000, balance=0, applied=True, status="Closed")
        self.client.force_login(self.users["encoder"])
        self.client.post(reverse("vale_edit", args=[vale.pk]), self.vale_payload(amount="3500.00"))
        self.client.post(reverse("cash_advance_edit", args=[cash.pk]), self.cash_payload(amount="1200.00"))
        vale.refresh_from_db(); cash.refresh_from_db()
        self.assertEqual(vale.balance, Decimal("2500.00"))
        self.assertEqual(vale.status, "Open")
        self.assertEqual(cash.balance, Decimal("0.00"))
        self.assertTrue(cash.applied)
        self.assertEqual(cash.status, "Settled")

    def test_dashboard_search_exports_and_delete_snapshot_message(self):
        vale = ValeRecord.objects.create(employee=self.employee, date_granted="2026-07-04", amount=3000, installment_amount=500, balance=2500, status="Open", notes="Find this vale")
        cash = CashAdvance.objects.create(employee=self.employee, date_granted="2026-07-04", amount=1000, balance=1000, status="Open")
        self.client.force_login(self.users["admin"])
        page = self.client.get(reverse("advances_list") + "?q=Find")
        self.assertContains(page, "Advance Employee")
        self.assertContains(self.client.get(reverse("advances_list")), "2500.00")
        self.assertIn("Advance Employee", self.client.get(reverse("vale_export")).content.decode())
        self.assertIn("Advance Employee", self.client.get(reverse("cash_advance_export")).content.decode())
        response = self.client.post(reverse("vale_delete", args=[vale.pk]), follow=True)
        self.assertContains(response, "payroll snapshots are unchanged")
        self.assertFalse(ValeRecord.objects.filter(pk=vale.pk).exists())
        self.client.post(reverse("cash_advance_delete", args=[cash.pk]))
        self.assertFalse(CashAdvance.objects.filter(pk=cash.pk).exists())

    def test_validation_and_csrf(self):
        self.client.force_login(self.users["encoder"])
        response = self.client.post(reverse("vale_new"), self.vale_payload(amount="0", installment_amount="-1"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Amount must be greater than zero")
        self.assertContains(response, "Installment amount cannot be negative")
        csrf_client = TestClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.users["admin"])
        self.assertEqual(csrf_client.post(reverse("cash_advance_new"), self.cash_payload()).status_code, 403)


class PayrollOperationsTests(TestCase):
    def setUp(self):
        self.users = {}
        for role in ("admin", "encoder", "viewer", "accounting"):
            group, _ = Group.objects.get_or_create(name=role)
            user = User.objects.create_user(f"payroll_{role}", password="test")
            user.groups.add(group)
            self.users[role] = user
        self.client_record = Client.objects.create(client_code="PAY-C", client_name="Payroll Client")
        self.asset = Asset.objects.create(asset_code="PAY-UNIT", asset_type=Asset.Type.TRAILER)
        self.driver = Employee.objects.create(employee_code="PAY-D", full_name="Payroll Driver", employee_type=Employee.Type.DRIVER, employment_status="Active", payroll_basis=Employee.PayrollBasis.PER_TRIP, active=True)
        self.helpers = [
            Employee.objects.create(employee_code=f"PAY-H{i}", full_name=f"Payroll Helper {i}", employee_type=Employee.Type.HELPER, employment_status="Active", payroll_basis=Employee.PayrollBasis.PER_TRIP, active=True)
            for i in (1, 2)
        ]
        self.operator = Employee.objects.create(employee_code="PAY-O", full_name="Payroll Operator", employee_type=Employee.Type.OPERATOR, employment_status="Active", payroll_basis=Employee.PayrollBasis.PER_DAY, daily_rate=800, active=True)
        self.trip = Trip.objects.create(trip_ticket_no="TT-PAY-001", trip_type=Trip.Type.SPOT, trip_date="2026-07-04", client=self.client_record, asset=self.asset, driver=self.driver, job_description="Payroll delivery service", status=Trip.Status.COMPLETED, driver_pay_rate=3000, helper_pay_rate=600, driver_additional_pay=150, helper_additional_pay=200)
        TripHelper.objects.create(trip=self.trip, employee=self.helpers[0], helper_order=1)
        TripHelper.objects.create(trip=self.trip, employee=self.helpers[1], helper_order=2)
        TripEmployeePayItem.objects.create(trip=self.trip, employee_type="Driver", label="Night Shift", amount=150, sort_order=1)
        TripEmployeePayItem.objects.create(trip=self.trip, employee_type="Helper", label="Heavy Load", amount=200, sort_order=1)

    def payload(self, employee, **overrides):
        payload = {
            "employee": employee.pk, "period_from": "2026-07-01", "period_to": "2026-07-31", "pay_date": "2026-07-31",
            "unit_description": "Payroll work", "days_count": "0", "gross_pay": "3000.00", "additional_pay": "150.00",
            "vale_deduction": "0", "cash_advance_deduction": "0", "sss": "0", "philhealth": "0", "pagibig": "0",
            "withholding_tax": "0", "change_deduction": "0", "other_deduction": "25.00", "remarks": "Payroll test",
        }
        payload.update(overrides)
        return payload

    def test_permissions_navigation_and_preview(self):
        for role, expected in (("admin", 200), ("accounting", 200), ("viewer", 200), ("encoder", 403)):
            self.client.force_login(self.users[role])
            self.assertEqual(self.client.get(reverse("payroll_list")).status_code, expected)
        self.client.force_login(self.users["viewer"])
        self.assertEqual(self.client.get(reverse("payroll_new")).status_code, 403)
        self.client.force_login(self.users["accounting"])
        response = self.client.get(reverse("payroll_new") + f"?employee={self.driver.pk}&period_from=2026-07-01&period_to=2026-07-31")
        self.assertContains(response, "TT-PAY-001")
        self.assertContains(response, "Night Shift")
        self.assertContains(response, "New Payroll")

    def test_driver_payroll_claims_trip_deducts_advances_and_calculates_net(self):
        vale = ValeRecord.objects.create(employee=self.driver, date_granted="2026-06-01", amount=1200, installment_amount=500, balance=1200, status="Open")
        cash = CashAdvance.objects.create(employee=self.driver, date_granted="2026-06-02", amount=1000, balance=1000, applied=False, status="Open")
        self.client.force_login(self.users["accounting"])
        response = self.client.post(reverse("payroll_new"), self.payload(self.driver, vale_deduction="500", cash_advance_deduction="1000"))
        entry = PayrollEntry.objects.get()
        self.assertRedirects(response, reverse("payroll_detail", args=[entry.pk]))
        self.assertEqual(entry.gross_pay, Decimal("3000.00"))
        self.assertEqual(entry.additional_pay, Decimal("150.00"))
        self.assertEqual(entry.net_pay, Decimal("1625.00"))
        self.assertEqual(list(PayrollTrip.objects.values_list("employee_id", "trip_id")), [(self.driver.pk, self.trip.pk)])
        self.assertEqual(list(PayrollAdditionalLine.objects.values_list("label", "amount")), [("Night Shift", Decimal("150.00"))])
        vale.refresh_from_db(); cash.refresh_from_db()
        self.assertEqual(vale.balance, Decimal("700.00"))
        self.assertEqual(cash.balance, Decimal("0.00"))
        self.assertEqual(cash.status, "Closed")
        self.assertTrue(cash.applied)

    def test_helper_share_and_labeled_additional_pay(self):
        preview = payroll_preview(self.helpers[0], date(2026, 7, 1), date(2026, 7, 31))
        self.assertEqual(preview["gross_pay"], Decimal("300.00"))
        self.assertEqual(preview["additional_pay"], Decimal("100.00"))
        self.assertEqual(preview["additional_lines"][0]["label"], "Heavy Load")
        self.client.force_login(self.users["accounting"])
        self.client.post(reverse("payroll_new"), self.payload(self.helpers[0], gross_pay="300", additional_pay="100", other_deduction="0"))
        entry = PayrollEntry.objects.get()
        self.assertEqual(entry.net_pay, Decimal("400.00"))
        self.assertEqual(entry.helper_trip_additional_pay, Decimal("100.00"))

    def test_operator_per_day_and_manual_amount(self):
        self.client.force_login(self.users["accounting"])
        response = self.client.post(reverse("payroll_new"), self.payload(self.operator, days_count="5", gross_pay="4000", additional_pay="200", other_deduction="100"))
        entry = PayrollEntry.objects.get()
        self.assertRedirects(response, reverse("payroll_detail", args=[entry.pk]))
        self.assertEqual(entry.days_count, Decimal("5.00"))
        self.assertEqual(entry.trips_count, 0)
        self.assertEqual(entry.net_pay, Decimal("4100.00"))
        self.assertEqual(PayrollTrip.objects.count(), 0)
        self.assertEqual(PayrollAdditionalLine.objects.get().label, "Manual Additional Pay")

    def test_duplicate_preview_rejected_and_saved_trip_excluded(self):
        preview = payroll_preview(self.driver, date(2026, 7, 1), date(2026, 7, 31))
        form_data = self.payload(self.driver)
        from .forms import PayrollForm
        form = PayrollForm(form_data, preview=preview)
        self.assertTrue(form.is_valid(), form.errors)
        create_payroll(form.cleaned_data, preview)
        self.assertEqual(payroll_preview(self.driver, date(2026, 7, 1), date(2026, 7, 31))["trips_count"], 0)
        with self.assertRaisesRegex(ValueError, "eligibility changed"):
            create_payroll(form.cleaned_data, preview)

    def test_delete_restores_advances_releases_trip_and_prints(self):
        vale = ValeRecord.objects.create(employee=self.driver, date_granted="2026-06-01", amount=1200, installment_amount=500, balance=1200, status="Open")
        cash = CashAdvance.objects.create(employee=self.driver, date_granted="2026-06-02", amount=1000, balance=1000, applied=False, status="Open")
        self.client.force_login(self.users["admin"])
        self.client.post(reverse("payroll_new"), self.payload(self.driver, vale_deduction="500", cash_advance_deduction="1000"))
        entry = PayrollEntry.objects.get()
        printable = self.client.get(reverse("payroll_print", args=[entry.pk]))
        self.assertContains(printable, "TT-PAY-001")
        self.assertContains(printable, "Trip Ticket / Waybill")
        self.assertContains(printable, "Item / Job")
        self.assertContains(printable, "Payroll delivery service")
        self.assertContains(printable, "Received by: / Employee Signature")
        self.assertContains(printable, "Remarks")
        html = printable.content.decode()
        self.assertLess(html.index("Payroll Summary"), html.index("Remarks"))
        self.assertLess(html.index("Remarks"), html.index("Deductions"))
        self.assertLess(html.index("Deductions"), html.index("Net Pay"))
        self.assertNotContains(printable, "Total Trips")
        self.assertNotContains(printable, "Pay Items")
        self.assertIn("Payroll Driver", self.client.get(reverse("payroll_export")).content.decode())
        response = self.client.post(reverse("payroll_delete", args=[entry.pk]), follow=True)
        self.assertContains(response, "deductions were restored")
        vale.refresh_from_db(); cash.refresh_from_db()
        self.assertEqual(vale.balance, Decimal("1200.00"))
        self.assertEqual(cash.balance, Decimal("1000.00"))
        self.assertFalse(cash.applied)
        self.assertEqual(PayrollTrip.objects.count(), 0)

    def test_validation_and_csrf(self):
        ValeRecord.objects.create(employee=self.driver, date_granted="2026-06-01", amount=500, installment_amount=100, balance=500, status="Open")
        self.client.force_login(self.users["accounting"])
        response = self.client.post(reverse("payroll_new"), self.payload(self.driver, period_from="2026-07-31", period_to="2026-07-01", gross_pay="-1", vale_deduction="900"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Period end must be on or after period start")
        csrf_client = TestClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.users["admin"])
        self.assertEqual(csrf_client.post(reverse("payroll_new"), self.payload(self.driver)).status_code, 403)


class BillingCollectionsTests(TestCase):
    def setUp(self):
        self.users = {}
        for role in ("admin", "encoder", "viewer", "accounting"):
            group, _ = Group.objects.get_or_create(name=role)
            user = User.objects.create_user(f"billing_{role}", password="test")
            user.groups.add(group)
            self.users[role] = user
        self.client_record = Client.objects.create(client_code="BILL-C", client_name="Billing Client", billing_address="Billing Address")
        self.driver = Employee.objects.create(employee_code="BILL-D", full_name="Billing Driver", employee_type=Employee.Type.DRIVER, employment_status="Active", payroll_basis=Employee.PayrollBasis.PER_TRIP)
        self.asset = Asset.objects.create(asset_code="BILL-UNIT", asset_type=Asset.Type.CARGO, plate_no="ABC-123", make_model="Cargo Model")
        self.trip = Trip.objects.create(trip_ticket_no="TT-BILL-001", trip_type=Trip.Type.SPOT, trip_date="2026-07-05", client=self.client_record, driver=self.driver, asset=self.asset, origin="A", destination="B", job_description="Delivery", status=Trip.Status.COMPLETED, base_trip_rate=10000, fuel_surcharge=500, loading_fee=100, tolls=50, other_charges=25)
        self.trip.reference_no = "OR-CLIENT-7788"
        self.trip.save(update_fields=["reference_no"])
        self.trip_two = Trip.objects.create(trip_ticket_no="TT-BILL-002", trip_type=Trip.Type.RECURRING, trip_date="2026-07-06", client=self.client_record, driver=self.driver, asset=self.asset, origin="B", destination="C", status=Trip.Status.COMPLETED, base_trip_rate=5000)

    def billing_payload(self, trip_ids=None, **overrides):
        payload = {
            "client": self.client_record.pk, "billing_date": "2026-07-06",
            "period_from": "2026-07-01", "period_to": "2026-07-31",
            "vat_enabled": "on", "notes": "July delivery billing",
            "trip_ids": json.dumps(trip_ids if trip_ids is not None else [self.trip.pk]),
            "adjustments": json.dumps([
                {"line_type": "Addition", "label": "Documentation", "amount": "500.00"},
                {"line_type": "Deduction", "label": "Discount", "amount": "100.00"},
            ]),
        }
        payload.update(overrides)
        return payload

    def collection_payload(self, statement, amount="2000.00", **overrides):
        payload = {"collection_date": "2026-07-06", "billing": statement.pk, "amount_paid": amount, "reference_no": "PAY-001", "payment_method": "Bank Transfer", "notes": "Payment"}
        payload.update(overrides)
        return payload

    def create_statement(self):
        self.client.force_login(self.users["accounting"])
        response = self.client.post(reverse("billing_new"), self.billing_payload())
        statement = BillingStatement.objects.get()
        self.assertRedirects(response, reverse("billing_detail", args=[statement.pk]))
        return statement

    def test_permissions_navigation_and_candidate_preview(self):
        for role, expected in (("admin", 200), ("accounting", 200), ("viewer", 200), ("encoder", 403)):
            self.client.force_login(self.users[role])
            self.assertEqual(self.client.get(reverse("billing_list")).status_code, expected)
            self.assertEqual(self.client.get(reverse("collections_list")).status_code, expected)
            self.assertEqual(self.client.get(reverse("billing_soa")).status_code, expected)
        self.client.force_login(self.users["viewer"])
        self.assertEqual(self.client.get(reverse("billing_new")).status_code, 403)
        self.assertEqual(self.client.get(reverse("collection_new")).status_code, 403)
        self.client.force_login(self.users["accounting"])
        response = self.client.get(reverse("billing_new") + f"?client={self.client_record.pk}&period_from=2026-07-01&period_to=2026-07-31")
        self.assertContains(response, "TT-BILL-001")
        self.assertContains(response, "TT-BILL-002")
        self.assertContains(response, "New Billing Statement")
        self.assertContains(self.client.get(reverse("billing_list")), "New Collection")

    def test_create_billing_vat_adjustments_snapshots_and_status(self):
        statement = self.create_statement()
        self.assertEqual(statement.billing_no, "BS-2026-000001")
        self.assertEqual(statement.base_charges_total, Decimal("10000.00"))
        self.assertEqual(statement.extra_charges_total, Decimal("675.00"))
        self.assertEqual(statement.gross_total, Decimal("10675.00"))
        self.assertEqual(statement.vat_amount, Decimal("1281.00"))
        self.assertEqual(statement.additions_total, Decimal("500.00"))
        self.assertEqual(statement.deductions_total, Decimal("100.00"))
        self.assertEqual(statement.grand_total, Decimal("12356.00"))
        self.assertEqual(list(BillingAdjustment.objects.values_list("line_type", "label", "amount")), [("Addition", "Documentation", Decimal("500.00")), ("Deduction", "Discount", Decimal("100.00"))])
        line = BillingLine.objects.get()
        self.assertEqual(line.amount_total, Decimal("10675.00"))
        self.trip.refresh_from_db(); self.trip_two.refresh_from_db()
        self.assertEqual(self.trip.status, Trip.Status.BILLED)
        self.assertEqual(self.trip_two.status, Trip.Status.COMPLETED)

    def test_stale_or_duplicate_trip_claim_is_rejected(self):
        from .forms import BillingForm
        form = BillingForm(self.billing_payload())
        self.assertTrue(form.is_valid(), form.errors)
        create_billing(form.cleaned_data)
        self.assertEqual(eligible_billing_trips(self.client_record, date(2026, 7, 1), date(2026, 7, 31)), [self.trip_two])
        with self.assertRaisesRegex(ValueError, "eligibility changed"):
            create_billing(form.cleaned_data)

    def test_partial_and_overpayment_update_status_and_outstanding(self):
        statement = self.create_statement()
        response = self.client.post(reverse("collection_new"), self.collection_payload(statement, "2000.00"))
        first = Collection.objects.get(reference_no="PAY-001")
        self.assertRedirects(response, reverse("collection_detail", args=[first.pk]))
        statement.refresh_from_db()
        self.assertEqual(statement.status, BillingStatement.Status.PARTIAL)
        self.client.post(reverse("collection_new"), self.collection_payload(statement, "12000.00", reference_no="PAY-002"))
        statement.refresh_from_db()
        self.assertEqual(statement.status, BillingStatement.Status.PAID)
        detail = self.client.get(reverse("billing_detail", args=[statement.pk]))
        self.assertContains(detail, "-1644.00")
        self.assertContains(detail, "PAY-002")

    def test_zero_and_negative_collection_legacy_parity(self):
        statement = self.create_statement()
        self.client.post(reverse("collection_new"), self.collection_payload(statement, "0.00", reference_no="ZERO"))
        statement.refresh_from_db()
        self.assertEqual(statement.status, BillingStatement.Status.OPEN)
        self.client.post(reverse("collection_new"), self.collection_payload(statement, "-100.00", reference_no="NEG"))
        statement.refresh_from_db()
        self.assertEqual(statement.status, BillingStatement.Status.OPEN)
        self.assertTrue(Collection.objects.filter(amount_paid=-100).exists())

    def test_delete_collection_recalculates_and_billing_delete_is_guarded(self):
        statement = self.create_statement()
        self.client.post(reverse("collection_new"), self.collection_payload(statement, "2000.00"))
        record = Collection.objects.get()
        blocked = self.client.post(reverse("billing_delete", args=[statement.pk]), follow=True)
        self.assertContains(blocked, "Delete those collections first")
        self.assertTrue(BillingStatement.objects.filter(pk=statement.pk).exists())
        self.client.post(reverse("collection_delete", args=[record.pk]))
        statement.refresh_from_db()
        self.assertEqual(statement.status, BillingStatement.Status.OPEN)
        response = self.client.post(reverse("billing_delete", args=[statement.pk]), follow=True)
        self.assertContains(response, "trip(s) reopened")
        self.trip.refresh_from_db()
        self.assertEqual(self.trip.status, Trip.Status.COMPLETED)
        self.assertFalse(BillingStatement.objects.filter(pk=statement.pk).exists())

    def test_print_search_exports_validation_and_csrf(self):
        statement = self.create_statement()
        printable = self.client.get(reverse("billing_print", args=[statement.pk]))
        self.assertContains(printable, "TT-BILL-001")
        self.assertContains(printable, "Trip Ticket / Waybill")
        self.assertContains(printable, "OR-CLIENT-7788")
        self.assertContains(printable, "₱ 10,675.00")
        self.assertContains(printable, "(₱ 100.00)")
        self.assertContains(printable, "Received/Conforme")
        self.assertContains(self.client.get(reverse("billing_list") + "?q=BS-2026"), "BS-2026-000001")
        self.assertContains(self.client.get(reverse("billing_list")), "Statement of Account")
        self.assertIn("BS-2026-000001", self.client.get(reverse("billing_export")).content.decode())
        self.client.post(reverse("collection_new"), self.collection_payload(statement))
        self.assertIn("PAY-001", self.client.get(reverse("collections_export")).content.decode())
        invalid = self.client.post(reverse("billing_new"), self.billing_payload(trip_ids=[], adjustments='[{"line_type":"Addition","label":"","amount":"0"}]'))
        self.assertEqual(invalid.status_code, 200)
        self.assertContains(invalid, "Select at least one completed trip")
        csrf_client = TestClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.users["admin"])
        self.assertEqual(csrf_client.post(reverse("collection_new"), self.collection_payload(statement)).status_code, 403)

    def test_statement_of_account_modes_as_of_dates_print_and_csv(self):
        open_statement = BillingStatement.objects.create(
            billing_no="BS-SOA-OPEN", client=self.client_record, billing_date="2026-07-01",
            period_from="2026-07-01", period_to="2026-07-10", grand_total=Decimal("1000.00"),
            base_charges_total=Decimal("1000.00"), extra_charges_total=0, gross_total=1000,
            vat_amount=0, additions_total=0, deductions_total=0, status=BillingStatement.Status.PAID,
        )
        paid_statement = BillingStatement.objects.create(
            billing_no="BS-SOA-PAID", client=self.client_record, billing_date="2026-07-20",
            period_from="2026-07-11", period_to="2026-07-20", grand_total=Decimal("500.00"),
            base_charges_total=Decimal("500.00"), extra_charges_total=0, gross_total=500,
            vat_amount=0, additions_total=0, deductions_total=0, status=BillingStatement.Status.PAID,
        )
        negative_statement = BillingStatement.objects.create(
            billing_no="BS-SOA-NEG", client=self.client_record, billing_date="2026-08-01",
            period_from="2026-08-01", period_to="2026-08-05", grand_total=Decimal("300.00"),
            base_charges_total=Decimal("300.00"), extra_charges_total=0, gross_total=300,
            vat_amount=0, additions_total=0, deductions_total=0, status=BillingStatement.Status.OPEN,
        )
        Collection.objects.create(collection_date="2026-07-15", client=self.client_record, billing=open_statement, amount_paid=Decimal("1000.00"), reference_no="PAID-LATER")
        Collection.objects.create(collection_date="2026-07-21", client=self.client_record, billing=paid_statement, amount_paid=Decimal("500.00"), reference_no="PAID-IN-PERIOD")
        Collection.objects.create(collection_date="2026-08-02", client=self.client_record, billing=negative_statement, amount_paid=Decimal("0.00"), reference_no="ZERO-SOA")
        Collection.objects.create(collection_date="2026-08-03", client=self.client_record, billing=negative_statement, amount_paid=Decimal("-100.00"), reference_no="NEG-SOA")
        self.client.force_login(self.users["accounting"])

        early = self.client.get(reverse("billing_soa"), {"client": self.client_record.pk, "mode": "outstanding", "as_of_date": "2026-07-10"})
        self.assertContains(early, "BS-SOA-OPEN")
        self.assertNotContains(early, "BS-SOA-PAID")
        self.assertContains(early, "1,000.00")

        later = self.client.get(reverse("billing_soa"), {"client": self.client_record.pk, "mode": "outstanding", "as_of_date": "2026-07-30"})
        self.assertNotContains(later, "BS-SOA-OPEN")
        self.assertNotContains(later, "BS-SOA-PAID")

        all_activity = self.client.get(reverse("billing_soa"), {"client": self.client_record.pk, "mode": "all", "as_of_date": "2026-07-30", "date_from": "2026-07-01", "date_to": "2026-07-31"})
        self.assertContains(all_activity, "BS-SOA-OPEN")
        self.assertContains(all_activity, "BS-SOA-PAID")
        self.assertNotContains(all_activity, "BS-SOA-NEG")

        negative = self.client.get(reverse("billing_soa"), {"client": self.client_record.pk, "mode": "outstanding", "as_of_date": "2026-08-04", "date_from": "2026-08-01", "date_to": "2026-08-31"})
        self.assertContains(negative, "BS-SOA-NEG")
        self.assertContains(negative, "400.00")

        printable = self.client.get(reverse("billing_soa_print"), {"client": self.client_record.pk, "mode": "all", "as_of_date": "2026-07-30", "date_from": "2026-07-01", "date_to": "2026-07-31"})
        self.assertContains(printable, "Statement of Account")
        self.assertContains(printable, "Billing Address")
        self.assertContains(printable, "Total Balance")
        self.assertContains(printable, "Received/Conforme")
        self.assertContains(printable, "BS-SOA-OPEN")

        response = self.client.get(reverse("billing_soa_export"), {"client": self.client_record.pk, "mode": "all", "as_of_date": "2026-07-30", "date_from": "2026-07-01", "date_to": "2026-07-31"})
        rows = list(csv.reader(StringIO(response.content.decode())))
        self.assertEqual(rows[0], ["Billing No", "Billing Date", "Period From", "Period To", "Grand Total", "Payments", "Balance", "Status"])
        self.assertEqual(rows[-1][0], "Totals")


class AccountingFormatTests(TestCase):
    def test_printable_accounting_format(self):
        self.assertEqual(accounting(Decimal("1234.5")), "₱ 1,234.50")
        self.assertEqual(accounting(Decimal("0")), "₱ -")
        self.assertEqual(accounting(Decimal("-25")), "(₱ 25.00)")
        self.assertEqual(accounting(Decimal("25"), "deduction"), "(₱ 25.00)")


class ReportWorkspaceTests(TestCase):
    def setUp(self):
        self.users = {}
        for role in ("admin", "encoder", "viewer", "accounting"):
            group, _ = Group.objects.get_or_create(name=role)
            user = User.objects.create_user(f"report_{role}", password="test")
            user.groups.add(group)
            self.users[role] = user
        self.client_record = Client.objects.create(client_code="REPORT-C", client_name="Report Client")
        self.asset = Asset.objects.create(asset_code="REPORT-UNIT", asset_type=Asset.Type.CARGO)
        self.trip = Trip.objects.create(
            trip_ticket_no="TT-REPORT-001", reference_no="REPORT-REF", trip_type=Trip.Type.SPOT,
            trip_date="2026-07-06", client=self.client_record, asset=self.asset,
            status=Trip.Status.COMPLETED, base_trip_rate=10000, fuel_surcharge=500,
        )

    def test_permissions_and_all_report_routes(self):
        for role, expected in (("admin", 200), ("accounting", 200), ("viewer", 200), ("encoder", 403)):
            self.client.force_login(self.users[role])
            self.assertEqual(self.client.get(reverse("reports")).status_code, expected)
            self.assertEqual(self.client.get(reverse("reports_print")).status_code, expected)
        self.client.force_login(self.users["viewer"])
        for slug, label in REPORTS.items():
            response = self.client.get(reverse("reports") + f"?report={slug}")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.context["report"]["label"], label)

    def test_filters_accounting_totals_and_empty_state(self):
        self.client.force_login(self.users["accounting"])
        response = self.client.get(reverse("reports") + "?report=unbilled_trips&q=REPORT-REF&date_from=2026-07-01&date_to=2026-07-31&status=Completed")
        self.assertContains(response, "TT-REPORT-001")
        self.assertContains(response, "10,000.00")
        self.assertContains(response, "Totals")
        empty = self.client.get(reverse("reports") + "?report=cash_advance_balance")
        self.assertContains(empty, "No rows match this report")
        invalid = self.client.get(reverse("reports") + "?report=unbilled_trips&date_from=2026-07-31&date_to=2026-07-01")
        self.assertContains(invalid, "End date must be on or after start date")

    def test_printable_report_preserves_filters_and_totals(self):
        self.client.force_login(self.users["accounting"])
        response = self.client.get(reverse("reports_print") + "?report=unbilled_trips&q=REPORT-REF&date_from=2026-07-01&date_to=2026-07-31&status=Completed")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "GMT Trucking")
        self.assertContains(response, "Unbilled Trips")
        self.assertContains(response, "Search:")
        self.assertContains(response, "REPORT-REF")
        self.assertContains(response, "Trip Ticket / Waybill")
        self.assertContains(response, "TT-REPORT-001")
        self.assertContains(response, "10,000.00")
        self.assertContains(response, "Print")
        empty = self.client.get(reverse("reports_print") + "?report=cash_advance_balance")
        self.assertContains(empty, "No rows match this report")

    def test_csv_uses_legacy_columns_and_numeric_values(self):
        self.client.force_login(self.users["viewer"])
        response = self.client.get(reverse("reports_export") + "?report=unbilled_trips")
        self.assertEqual(response.status_code, 200)
        rows = list(csv.reader(StringIO(response.content.decode())))
        self.assertEqual(rows[0], ["Trip Ticket / Waybill", "Date", "Client", "Base Rate"])
        self.assertEqual(rows[1], ["TT-REPORT-001", "2026-07-06", "Report Client", "10000.00"])

    def test_fleet_utilization_and_receivable_calculation(self):
        fleet = build_report("fleet_utilization")
        self.assertEqual(fleet["raw_rows"], [("REPORT-UNIT", Asset.Type.CARGO, 1, Decimal("10000.00"), Decimal("500.00"))])
        statement = BillingStatement.objects.create(
            billing_no="BS-REPORT-001", client=self.client_record, billing_date="2026-07-06",
            base_charges_total=10000, extra_charges_total=500, gross_total=10500,
            grand_total=10500, status=BillingStatement.Status.PARTIAL,
        )
        Collection.objects.create(collection_date="2026-07-06", client=self.client_record, billing=statement, amount_paid=2500)
        receivables = build_report("receivables_summary")
        self.assertEqual(receivables["raw_rows"][0][3], Decimal("8000.00"))


@skipUnless(FIXTURE.is_file(), "Local sanitized SQLite fixture is intentionally excluded from GitHub")
class ReportFixtureParityTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command("import_legacy", source=FIXTURE, stdout=StringIO())
        cls.baseline = json.loads((FIXTURE.parent / "baseline.json").read_text(encoding="utf-8"))["reports"]

    def test_all_twelve_report_datasets_match_baseline(self):
        def normalized(value):
            if hasattr(value, "isoformat"):
                return value.isoformat()
            if isinstance(value, Decimal):
                return float(value)
            return value
        def normalized_header(value):
            return "Trip Ticket / Waybill" if value == "Trip Ticket" else value

        self.assertEqual(set(REPORTS), set(self.baseline))
        for slug in REPORTS:
            result = build_report(slug)
            self.assertEqual([column["label"] for column in result["columns"]], [normalized_header(header) for header in self.baseline[slug]["headers"]], slug)
            actual = [[normalized(value) for value in row] for row in result["raw_rows"]]
            expected = self.baseline[slug]["rows"]
            self.assertEqual(len(actual), len(expected), slug)
            for actual_row, expected_row in zip(actual, expected):
                self.assertEqual(len(actual_row), len(expected_row), slug)
                for actual_value, expected_value in zip(actual_row, expected_row):
                    if isinstance(actual_value, (int, float)) and isinstance(expected_value, (int, float)):
                        self.assertAlmostEqual(actual_value, expected_value, delta=0.01, msg=slug)
                    else:
                        self.assertEqual(actual_value, expected_value, slug)
