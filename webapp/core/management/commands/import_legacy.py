import json
import sqlite3
from datetime import date, time
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

from django.conf import settings
from django.contrib.auth.models import Group, User
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Sum

from core.models import (
    Asset, BillingAdjustment, BillingLine, BillingStatement, CashAdvance,
    Client, Collection, Employee, Payable, PayrollAdditionalLine, PayrollEntry,
    PayrollTrip, RecurringTripMaster, Repair, Supplier, SystemSetting, Trip,
    TripEmployeePayItem, TripHelper, ValeRecord,
)


Q = Decimal("0.01")


def money(value):
    return Decimal(str(value or 0)).quantize(Q, rounding=ROUND_HALF_UP)


def as_date(value):
    return date.fromisoformat(value) if value else None


def as_time(value):
    if not value:
        return None
    return time.fromisoformat(value)


class Command(BaseCommand):
    help = "Atomically import a GMT desktop SQLite database into the web schema"

    def add_arguments(self, parser):
        parser.add_argument("--source", required=True, type=Path)
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument("--replace", action="store_true")
        parser.add_argument(
            "--skip-users",
            action="store_true",
            help="Import domain data without legacy users or password hashes",
        )

    def handle(self, *args, **options):
        source = options["source"].resolve()
        if not source.is_file():
            raise CommandError(f"Source database not found: {source}")
        if options["replace"] and not settings.DEBUG:
            raise CommandError("--replace is disabled when GMT_DEBUG is false")
        uri = f"file:{source.as_posix()}?mode=ro"
        source_db = sqlite3.connect(uri, uri=True)
        source_db.row_factory = sqlite3.Row
        required = {"users", "employees", "assets", "clients", "suppliers", "trips", "payroll_entries", "billing_statements"}
        available = {r[0] for r in source_db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not required.issubset(available):
            raise CommandError(f"Invalid GMT database; missing: {sorted(required - available)}")

        report = {"source": str(source), "dry_run": options["dry_run"], "replace": options["replace"], "skip_users": options["skip_users"], "counts": {}, "repairs": [], "warnings": []}
        try:
            with transaction.atomic():
                if options["replace"]:
                    self._clear_target(skip_users=options["skip_users"])
                self._import_all(source_db, report, skip_users=options["skip_users"])
                self._validate(source_db, report)
                if options["dry_run"]:
                    transaction.set_rollback(True)
        finally:
            source_db.close()
        self.stdout.write(json.dumps(report, indent=2, sort_keys=True, default=str))
        if options["dry_run"]:
            self.stdout.write(self.style.WARNING("Dry run validated successfully; target changes rolled back."))
        else:
            self.stdout.write(self.style.SUCCESS("Legacy import completed successfully."))

    def _rows(self, db, table):
        return db.execute(f'SELECT * FROM "{table}" ORDER BY id').fetchall()

    def _track(self, report, table, count):
        report["counts"][table] = count

    def _clear_target(self, skip_users=False):
        for model in (
            Collection, BillingAdjustment, BillingLine, BillingStatement,
            PayrollAdditionalLine, PayrollTrip, PayrollEntry, CashAdvance,
            ValeRecord, TripEmployeePayItem, TripHelper, Payable, Repair, Trip,
            RecurringTripMaster, Asset, Supplier, Client, Employee, SystemSetting,
        ):
            model.objects.all().delete()
        if not skip_users:
            User.objects.all().delete()

    def _import_all(self, db, report, skip_users=False):
        settings_rows = db.execute("SELECT setting_key,setting_value FROM settings ORDER BY setting_key").fetchall()
        for row in settings_rows:
            SystemSetting.objects.update_or_create(key=row["setting_key"], defaults={"value": row["setting_value"] or ""})
        self._track(report, "settings", len(settings_rows))

        if skip_users:
            self._track(report, "users", 0)
            report["warnings"].append("Legacy users and password hashes were intentionally skipped.")
        else:
            user_rows = self._rows(db, "users")
            for row in user_rows:
                role = row["role"] if row["role"] in {"admin", "encoder", "viewer", "accounting"} else "viewer"
                group, _ = Group.objects.get_or_create(name=role)
                user, _ = User.objects.update_or_create(pk=row["id"], defaults={
                    "username": row["username"], "is_active": bool(row["is_active"]),
                    "is_staff": role == "admin", "is_superuser": role == "admin",
                    "password": f"legacy_sha256${row['password_hash']}",
                })
                user.groups.set([group])
            self._track(report, "users", len(user_rows))

        employee_rows = self._rows(db, "employees")
        for r in employee_rows:
            Employee.objects.update_or_create(pk=r["id"], defaults={
                "employee_code": r["employee_code"] or None, "full_name": r["full_name"],
                "employee_type": r["employee_type"], "contact_no": r["contact_no"] or "",
                "address": r["address"] or "", "date_hired": as_date(r["date_hired"]),
                "employment_status": r["employment_status"] or "Active", "payroll_basis": r["payroll_basis"] or "Per Trip",
                "daily_rate": money(r["daily_rate"]), "trip_rate": money(r["trip_rate"]),
                "notes": r["notes"] or "", "active": bool(r["active"]),
            })
        self._track(report, "employees", len(employee_rows))

        client_rows = self._rows(db, "clients")
        for r in client_rows:
            Client.objects.update_or_create(pk=r["id"], defaults={
                "client_code": r["client_code"] or None, "client_name": r["client_name"],
                "billing_address": r["billing_address"] or "", "contact_person": r["contact_person"] or "",
                "contact_no": r["contact_no"] or "", "terms_days": r["terms_days"] or 30,
                "notes": r["notes"] or "", "active": bool(r["active"]),
            })
        self._track(report, "clients", len(client_rows))

        supplier_rows = self._rows(db, "suppliers")
        for r in supplier_rows:
            Supplier.objects.update_or_create(pk=r["id"], defaults={
                "supplier_name": r["supplier_name"], "contact_person": r["contact_person"] or "",
                "contact_no": r["contact_no"] or "", "address": r["address"] or "", "notes": r["notes"] or "",
            })
        self._track(report, "suppliers", len(supplier_rows))

        asset_rows = self._rows(db, "assets")
        for r in asset_rows:
            Asset.objects.update_or_create(pk=r["id"], defaults={
                "asset_code": r["asset_code"], "asset_type": r["asset_type"], "plate_no": r["plate_no"] or "",
                "make_model": r["make_model"] or "", "capacity_desc": r["capacity_desc"] or "",
                "status": r["status"] or "Available", "assigned_employee_id": r["assigned_employee_id"], "notes": r["notes"] or "",
            })
        self._track(report, "assets", len(asset_rows))

        recurring_rows = self._rows(db, "recurring_trip_masters")
        for r in recurring_rows:
            RecurringTripMaster.objects.update_or_create(pk=r["id"], defaults={
                "master_code": r["master_code"] or None, "client_id": r["client_id"],
                "job_description": r["job_description"] or "", "origin": r["origin"] or "", "destination": r["destination"] or "",
                "default_asset_id": r["default_asset_id"], "default_driver_id": r["default_driver_id"],
                "default_helper_count": r["default_helper_count"] or 0, "standard_base_rate": money(r["standard_base_rate"]),
                "driver_pay_rate": money(r["driver_pay_rate"]), "helper_pay_rate": money(r["helper_pay_rate"]),
                "default_extra_note": r["default_extra_note"] or "", "remarks": r["remarks"] or "", "active": bool(r["active"]),
            })
        self._track(report, "recurring_trip_masters", len(recurring_rows))

        valid_master_ids = set(RecurringTripMaster.objects.values_list("id", flat=True))
        trip_rows = self._rows(db, "trips")
        for r in trip_rows:
            master_id = r["recurring_master_id"]
            if master_id and master_id not in valid_master_ids:
                report["repairs"].append({"table": "trips", "id": r["id"], "field": "recurring_master_id", "old_value": master_id, "new_value": None})
                master_id = None
            Trip.objects.update_or_create(pk=r["id"], defaults={
                "trip_ticket_no": r["trip_ticket_no"], "trip_type": r["trip_type"], "recurring_master_id": master_id,
                "trip_date": as_date(r["trip_date"]), "client_id": r["client_id"], "job_description": r["job_description"] or "",
                "origin": r["origin"] or "", "destination": r["destination"] or "", "asset_id": r["asset_id"], "driver_id": r["driver_id"],
                "dispatch_time": as_time(r["dispatch_time"]), "arrival_time": as_time(r["arrival_time"]), "status": r["status"] or "Planned",
                **{field: money(r[field]) for field in ("base_trip_rate", "driver_pay_rate", "helper_pay_rate", "driver_additional_pay", "helper_additional_pay", "fuel_surcharge", "loading_fee", "unloading_fee", "waiting_fee", "tolls", "additional_stop_charge", "special_handling_fee", "other_charges")},
                "notes": r["notes"] or "",
            })
        self._track(report, "trips", len(trip_rows))

        helper_rows = self._rows(db, "trip_helpers")
        for r in helper_rows:
            TripHelper.objects.update_or_create(pk=r["id"], defaults={"trip_id": r["trip_id"], "employee_id": r["employee_id"], "helper_order": r["helper_order"] or 1})
        self._track(report, "trip_helpers", len(helper_rows))

        pay_item_rows = self._rows(db, "trip_employee_pay_items")
        for r in pay_item_rows:
            TripEmployeePayItem.objects.update_or_create(pk=r["id"], defaults={"trip_id": r["trip_id"], "employee_type": r["employee_type"], "label": r["label"], "amount": money(r["amount"]), "sort_order": r["sort_order"] or 0})
        self._track(report, "trip_employee_pay_items", len(pay_item_rows))

        repair_rows = self._rows(db, "repairs")
        for r in repair_rows:
            Repair.objects.update_or_create(pk=r["id"], defaults={
                "repair_date": as_date(r["repair_date"]), "asset_id": r["asset_id"], "repair_description": r["repair_description"],
                "meter_value": r["meter_value"] or "", "supplier_id": r["supplier_id"],
                "parts_cost": money(r["parts_cost"]), "labor_cost": money(r["labor_cost"]), "other_cost": money(r["other_cost"]), "total_cost": money(r["total_cost"]),
                "status": r["status"] or "Open", "notes": r["notes"] or "", "auto_generate_payable": bool(r["auto_generate_payable"]),
            })
        self._track(report, "repairs", len(repair_rows))

        payable_rows = self._rows(db, "payables")
        for r in payable_rows:
            Payable.objects.update_or_create(pk=r["id"], defaults={
                "payable_date": as_date(r["payable_date"]), "supplier_id": r["supplier_id"], "source_type": r["source_type"] or "",
                "reference_no": r["reference_no"] or "", "description": r["description"] or "", "amount": money(r["amount"]),
                "due_date": as_date(r["due_date"]), "status": r["status"] or "Open", "notes": r["notes"] or "", "linked_repair_id": r["linked_repair_id"],
            })
        self._track(report, "payables", len(payable_rows))

        for table, model, fields in (
            ("vale_records", ValeRecord, ("amount", "installment_amount", "balance")),
            ("cash_advances", CashAdvance, ("amount", "balance")),
        ):
            rows = self._rows(db, table)
            for r in rows:
                defaults = {"employee_id": r["employee_id"], "date_granted": as_date(r["date_granted"]), "status": r["status"] or "Open", "notes": r["notes"] or ""}
                defaults.update({f: money(r[f]) for f in fields})
                if table == "cash_advances": defaults["applied"] = bool(r["applied"])
                model.objects.update_or_create(pk=r["id"], defaults=defaults)
            self._track(report, table, len(rows))

        payroll_rows = self._rows(db, "payroll_entries")
        payroll_source_trips = {}
        for r in payroll_rows:
            PayrollEntry.objects.update_or_create(pk=r["id"], defaults={
                "pay_date": as_date(r["pay_date"]), "period_from": as_date(r["period_from"]), "period_to": as_date(r["period_to"]),
                "employee_id": r["employee_id"], "employee_type": r["employee_type"] or "", "payroll_basis": r["payroll_basis"] or "",
                "unit_description": r["unit_description"] or "", "trips_count": r["trips_count"] or 0, "days_count": money(r["days_count"]),
                **{f: money(r[f]) for f in ("gross_pay", "additional_pay", "driver_trip_additional_pay", "helper_trip_additional_pay", "vale_deduction", "cash_advance_deduction", "sss", "philhealth", "pagibig", "withholding_tax", "change_deduction", "other_deduction", "net_pay")},
                "remarks": r["remarks"] or "",
            })
            payroll_source_trips[r["id"]] = [int(x) for x in str(r["source_trip_ids"] or "").split(",") if x.strip().isdigit()]
        self._track(report, "payroll_entries", len(payroll_rows))
        PayrollTrip.objects.all().delete()
        for payroll_id, trip_ids in payroll_source_trips.items():
            payroll = PayrollEntry.objects.get(pk=payroll_id)
            for trip_id in trip_ids:
                PayrollTrip.objects.create(payroll=payroll, trip_id=trip_id, employee=payroll.employee)
        report["counts"]["payroll_trip_links"] = PayrollTrip.objects.count()

        line_rows = self._rows(db, "payroll_entry_additional_lines")
        for r in line_rows:
            PayrollAdditionalLine.objects.update_or_create(pk=r["id"], defaults={"payroll_id": r["payroll_id"], "employee_type": r["employee_type"], "label": r["label"], "amount": money(r["amount"]), "sort_order": r["sort_order"] or 0})
        self._track(report, "payroll_entry_additional_lines", len(line_rows))

        billing_rows = self._rows(db, "billing_statements")
        for r in billing_rows:
            BillingStatement.objects.update_or_create(pk=r["id"], defaults={
                "billing_no": r["billing_no"], "client_id": r["client_id"], "billing_date": as_date(r["billing_date"]),
                "period_from": as_date(r["period_from"]), "period_to": as_date(r["period_to"]),
                **{f: money(r[f]) for f in ("base_charges_total", "extra_charges_total", "gross_total", "vat_amount", "additions_total", "deductions_total", "grand_total")},
                "vat_enabled": bool(r["vat_enabled"]), "status": r["status"] or "Open", "notes": r["notes"] or "",
            })
        self._track(report, "billing_statements", len(billing_rows))

        for table, model, fk in (("billing_statement_lines", BillingLine, "billing_id"), ("billing_statement_adjustments", BillingAdjustment, "billing_id")):
            rows = self._rows(db, table)
            for r in rows:
                if table.endswith("lines"):
                    defaults = {"billing_id": r[fk], "trip_id": r["trip_id"], "amount_base": money(r["amount_base"]), "amount_extra": money(r["amount_extra"]), "amount_total": money(r["amount_total"])}
                else:
                    defaults = {"billing_id": r[fk], "line_type": r["line_type"], "label": r["label"], "amount": money(r["amount"]), "sort_order": r["sort_order"] or 0}
                model.objects.update_or_create(pk=r["id"], defaults=defaults)
            self._track(report, table, len(rows))

        collection_rows = self._rows(db, "collections")
        for r in collection_rows:
            Collection.objects.update_or_create(pk=r["id"], defaults={
                "collection_date": as_date(r["collection_date"]), "client_id": r["client_id"], "billing_id": r["billing_id"],
                "amount_paid": money(r["amount_paid"]), "reference_no": r["reference_no"] or "", "payment_method": r["payment_method"] or "", "notes": r["notes"] or "",
            })
        self._track(report, "collections", len(collection_rows))

    def _validate(self, db, report):
        if len(report["repairs"]) != 4:
            raise CommandError(f"Expected 4 broken recurring links, found {len(report['repairs'])}")
        if TripHelper.objects.count() != db.execute("SELECT COUNT(*) FROM trip_helpers").fetchone()[0]:
            raise CommandError("Helper assignment count mismatch")
        if TripHelper.objects.values("trip_id", "employee_id").distinct().count() != TripHelper.objects.count():
            raise CommandError("Duplicate helper assignments detected")
        if PayrollTrip.objects.values("employee_id", "trip_id").distinct().count() != PayrollTrip.objects.count():
            raise CommandError("Duplicate employee/trip payroll claims detected")

        controls = [
            ("trips", Trip, "base_trip_rate"), ("repairs", Repair, "total_cost"),
            ("payables", Payable, "amount"), ("vale_records", ValeRecord, "balance"),
            ("cash_advances", CashAdvance, "balance"), ("payroll_entries", PayrollEntry, "net_pay"),
            ("billing_statements", BillingStatement, "grand_total"), ("collections", Collection, "amount_paid"),
        ]
        for table, model, field in controls:
            source_total = money(db.execute(f'SELECT COALESCE(SUM("{field}"),0) FROM "{table}"').fetchone()[0])
            target_total = (model.objects.aggregate(total=Sum(field))["total"] or Decimal("0")).quantize(Q)
            if abs(source_total - target_total) > Q:
                raise CommandError(f"Financial control mismatch: {table}.{field}: {source_total} != {target_total}")
        report["validation"] = {"orphan_repairs": len(report["repairs"]), "helper_assignments": TripHelper.objects.count(), "payroll_trip_links": PayrollTrip.objects.count(), "financial_controls": "matched"}
