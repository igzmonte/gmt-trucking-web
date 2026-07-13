"""Export the current Django SQLite data into Cloudflare D1-compatible SQL.

This helper is intentionally read-only. It does not modify the source database.

Usage:
    python cloudflare/tools/export_django_sqlite_to_d1.py webapp/dev.sqlite3 > cloudflare/import.sql

Users are skipped by default because hosted Cloudflare users should be created
with fresh credentials.
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


TABLES = {
    "core_employee": ("employees", [
        "id", "employee_code", "full_name", "employee_type", "contact_no", "address", "date_hired",
        "employment_status", "payroll_basis", "daily_rate", "trip_rate", "notes", "active",
    ]),
    "core_asset": ("assets", [
        "id", "asset_code", "asset_type", "plate_no", "make_model", "capacity_desc", "status",
        "assigned_employee_id", "notes",
    ]),
    "core_client": ("clients", [
        "id", "client_code", "client_name", "billing_address", "contact_person", "contact_no",
        "terms_days", "notes", "active",
    ]),
    "core_supplier": ("suppliers", [
        "id", "supplier_name", "contact_person", "contact_no", "address", "notes",
    ]),
    "core_recurringtripmaster": ("recurring_trip_masters", [
        "id", "master_code", "client_id", "job_description", "origin", "destination", "default_asset_id",
        "default_driver_id", "default_helper_count", "standard_base_rate", "driver_pay_rate",
        "helper_pay_rate", "default_extra_note", "remarks", "active",
    ]),
    "core_trip": ("trips", [
        "id", "trip_ticket_no", "reference_no", "trip_type", "recurring_master_id", "trip_date", "client_id",
        "job_description", "origin", "destination", "asset_id", "driver_id", "dispatch_time", "arrival_time",
        "status", "base_trip_rate", "driver_pay_rate", "helper_pay_rate", "driver_additional_pay",
        "helper_additional_pay", "fuel_surcharge", "loading_fee", "unloading_fee", "waiting_fee", "tolls",
        "additional_stop_charge", "special_handling_fee", "other_charges", "notes",
    ]),
    "core_triphelper": ("trip_helpers", ["id", "trip_id", "employee_id", "helper_order"]),
    "core_tripemployeepayitem": ("trip_employee_pay_items", ["id", "trip_id", "employee_type", "label", "amount", "sort_order"]),
    "core_repair": ("repairs", [
        "id", "repair_date", "asset_id", "repair_description", "meter_value", "supplier_id", "parts_cost",
        "labor_cost", "other_cost", "total_cost", "status", "notes", "auto_generate_payable",
    ]),
    "core_payable": ("payables", [
        "id", "payable_date", "supplier_id", "source_type", "reference_no", "description", "amount",
        "due_date", "status", "notes", "linked_repair_id",
    ]),
    "core_valerecord": ("vale_records", ["id", "employee_id", "date_granted", "amount", "installment_amount", "balance", "status", "notes"]),
    "core_cashadvance": ("cash_advances", ["id", "employee_id", "date_granted", "amount", "balance", "applied", "status", "notes"]),
    "core_payrollentry": ("payroll_entries", [
        "id", "pay_date", "period_from", "period_to", "employee_id", "employee_type", "payroll_basis",
        "unit_description", "trips_count", "days_count", "gross_pay", "additional_pay",
        "driver_trip_additional_pay", "helper_trip_additional_pay", "vale_deduction",
        "cash_advance_deduction", "sss", "philhealth", "pagibig", "withholding_tax",
        "change_deduction", "other_deduction", "net_pay", "remarks",
    ]),
    "core_payrolltrip": ("payroll_trips", ["id", "payroll_id", "trip_id", "employee_id"]),
    "core_payrolladditionalline": ("payroll_additional_lines", ["id", "payroll_id", "employee_type", "label", "amount", "sort_order"]),
    "core_billingstatement": ("billing_statements", [
        "id", "billing_no", "client_id", "billing_date", "period_from", "period_to", "base_charges_total",
        "extra_charges_total", "gross_total", "vat_enabled", "vat_amount", "additions_total",
        "deductions_total", "grand_total", "status", "notes",
    ]),
    "core_billingline": ("billing_lines", ["id", "billing_id", "trip_id", "amount_base", "amount_extra", "amount_total"]),
    "core_billingadjustment": ("billing_adjustments", ["id", "billing_id", "line_type", "label", "amount", "sort_order"]),
    "core_collection": ("collections", ["id", "collection_date", "client_id", "billing_id", "amount_paid", "reference_no", "payment_method", "notes"]),
    "core_systemsetting": ("system_settings", ["key", "value"]),
}


def quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def available_columns(cursor, table):
    return {row[1] for row in cursor.execute(f"PRAGMA table_info({table})")}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    if not args.source.exists():
        raise SystemExit(f"Source database not found: {args.source}")

    connection = sqlite3.connect(f"file:{args.source}?mode=ro", uri=True)
    cursor = connection.cursor()
    print("PRAGMA foreign_keys=OFF;")
    print("BEGIN TRANSACTION;")
    for source, (target, columns) in TABLES.items():
        exists = cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (source,)).fetchone()
        if not exists:
            continue
        present = available_columns(cursor, source)
        used = [column for column in columns if column in present]
        rows = cursor.execute(f"SELECT {', '.join(used)} FROM {source}").fetchall()
        for row in rows:
            values = ", ".join(quote(value) for value in row)
            print(f"INSERT OR REPLACE INTO {target} ({', '.join(used)}) VALUES ({values});")
    print("COMMIT;")
    print("PRAGMA foreign_keys=ON;")


if __name__ == "__main__":
    main()
