#!/usr/bin/env python3
"""Export Django SQLite data into Cloudflare D1-compatible SQL.

This tool is intentionally conservative:

* It opens the source SQLite database read-only.
* It skips application users by default.
* It emits INSERT OR REPLACE statements only; it does not wipe D1 tables.
* It can produce an import manifest so a D1 `/data-tools` check can be compared
  after import.

Backward compatibility is preserved:

    python export_django_sqlite_to_d1.py webapp/dev.sqlite3 > cloudflare/import.sql
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any


TABLES: dict[str, tuple[str, list[str]]] = {
    "core_employee": (
        "employees",
        [
            "id",
            "employee_code",
            "full_name",
            "employee_type",
            "contact_no",
            "address",
            "date_hired",
            "employment_status",
            "payroll_basis",
            "daily_rate",
            "trip_rate",
            "notes",
            "active",
        ],
    ),
    "core_asset": (
        "assets",
        [
            "id",
            "asset_code",
            "asset_type",
            "plate_no",
            "make_model",
            "capacity_desc",
            "status",
            "assigned_employee_id",
            "notes",
        ],
    ),
    "core_client": (
        "clients",
        [
            "id",
            "client_code",
            "client_name",
            "billing_address",
            "contact_person",
            "contact_no",
            "terms_days",
            "notes",
            "active",
        ],
    ),
    "core_supplier": (
        "suppliers",
        ["id", "supplier_name", "contact_person", "contact_no", "address", "notes"],
    ),
    "core_recurringtripmaster": (
        "recurring_trip_masters",
        [
            "id",
            "master_code",
            "client_id",
            "job_description",
            "origin",
            "destination",
            "default_asset_id",
            "default_driver_id",
            "default_helper_count",
            "standard_base_rate",
            "driver_pay_rate",
            "helper_pay_rate",
            "default_extra_note",
            "remarks",
            "active",
        ],
    ),
    "core_trip": (
        "trips",
        [
            "id",
            "trip_ticket_no",
            "reference_no",
            "trip_type",
            "recurring_master_id",
            "trip_date",
            "client_id",
            "job_description",
            "origin",
            "destination",
            "asset_id",
            "driver_id",
            "dispatch_time",
            "arrival_time",
            "status",
            "base_trip_rate",
            "driver_pay_rate",
            "helper_pay_rate",
            "driver_additional_pay",
            "helper_additional_pay",
            "fuel_surcharge",
            "loading_fee",
            "unloading_fee",
            "waiting_fee",
            "tolls",
            "additional_stop_charge",
            "special_handling_fee",
            "other_charges",
            "notes",
        ],
    ),
    "core_triphelper": ("trip_helpers", ["id", "trip_id", "employee_id", "helper_order"]),
    "core_tripemployeepayitem": (
        "trip_employee_pay_items",
        ["id", "trip_id", "employee_type", "label", "amount", "sort_order"],
    ),
    "core_repair": (
        "repairs",
        [
            "id",
            "repair_date",
            "asset_id",
            "repair_description",
            "meter_value",
            "supplier_id",
            "parts_cost",
            "labor_cost",
            "other_cost",
            "total_cost",
            "status",
            "notes",
            "auto_generate_payable",
        ],
    ),
    "core_payable": (
        "payables",
        [
            "id",
            "payable_date",
            "supplier_id",
            "source_type",
            "reference_no",
            "description",
            "amount",
            "due_date",
            "status",
            "notes",
            "linked_repair_id",
        ],
    ),
    "core_valerecord": (
        "vale_records",
        ["id", "employee_id", "date_granted", "amount", "installment_amount", "balance", "status", "notes"],
    ),
    "core_cashadvance": (
        "cash_advances",
        ["id", "employee_id", "date_granted", "amount", "balance", "applied", "status", "notes"],
    ),
    "core_payrollentry": (
        "payroll_entries",
        [
            "id",
            "pay_date",
            "period_from",
            "period_to",
            "employee_id",
            "employee_type",
            "payroll_basis",
            "unit_description",
            "trips_count",
            "days_count",
            "gross_pay",
            "additional_pay",
            "driver_trip_additional_pay",
            "helper_trip_additional_pay",
            "vale_deduction",
            "cash_advance_deduction",
            "sss",
            "philhealth",
            "pagibig",
            "withholding_tax",
            "change_deduction",
            "other_deduction",
            "net_pay",
            "remarks",
        ],
    ),
    "core_payrolltrip": ("payroll_trips", ["id", "payroll_id", "trip_id", "employee_id"]),
    "core_payrolladditionalline": (
        "payroll_additional_lines",
        ["id", "payroll_id", "employee_type", "label", "amount", "sort_order"],
    ),
    "core_billingstatement": (
        "billing_statements",
        [
            "id",
            "billing_no",
            "client_id",
            "billing_date",
            "period_from",
            "period_to",
            "base_charges_total",
            "extra_charges_total",
            "gross_total",
            "vat_enabled",
            "vat_amount",
            "additions_total",
            "deductions_total",
            "grand_total",
            "status",
            "notes",
        ],
    ),
    "core_billingline": ("billing_lines", ["id", "billing_id", "trip_id", "amount_base", "amount_extra", "amount_total"]),
    "core_billingadjustment": ("billing_adjustments", ["id", "billing_id", "line_type", "label", "amount", "sort_order"]),
    "core_collection": (
        "collections",
        ["id", "collection_date", "client_id", "billing_id", "amount_paid", "reference_no", "payment_method", "notes"],
    ),
    "core_systemsetting": ("system_settings", ["key", "value"]),
}


USER_TABLES: dict[str, tuple[str, list[str]]] = {
    # Cloudflare-native user rows only. Django auth_user rows are deliberately
    # not mapped because their password format and groups are not D1-compatible.
    "users": (
        "users",
        ["id", "username", "password_hash", "first_name", "last_name", "email", "role", "active", "created_at"],
    )
}


MONEY_ZERO = Decimal("0.00")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export Django SQLite rows as Cloudflare D1-compatible INSERT OR REPLACE SQL."
    )
    parser.add_argument("source", help="Path to the source Django SQLite database.")
    parser.add_argument("--output-sql", help="Write generated SQL to this path instead of stdout.")
    parser.add_argument("--summary-json", help="Write an import manifest JSON to this path.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and summarize the source without writing SQL to stdout or --output-sql.",
    )
    parser.add_argument(
        "--include-users",
        action="store_true",
        help=(
            "Testing only: include a compatible Cloudflare users table if present. "
            "Do not use this for production cutover; manage real users in User Management."
        ),
    )
    return parser.parse_args(argv)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def connect_readonly(path: Path) -> sqlite3.Connection:
    uri = f"file:{path.resolve().as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bytes):
        return "X'" + value.hex() + "'"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).replace("'", "''")
    return f"'{text}'"


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone()
    return row is not None


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f'PRAGMA table_info("{table}")')}


def count_rows(conn: sqlite3.Connection, table: str) -> int:
    return int(conn.execute(f'SELECT COUNT(*) AS count FROM "{table}"').fetchone()["count"])


def decimal_sum(conn: sqlite3.Connection, table: str, expression: str, where: str | None = None) -> Decimal:
    if not table_exists(conn, table):
        return MONEY_ZERO
    sql = f'SELECT COALESCE(SUM({expression}), 0) AS total FROM "{table}"'
    if where:
        sql += f" WHERE {where}"
    value = conn.execute(sql).fetchone()["total"]
    return Decimal(str(value or 0)).quantize(MONEY_ZERO)


def add_warning(warnings: list[dict[str, str]], code: str, message: str) -> None:
    warnings.append({"code": code, "message": message})


def collect_financial_totals(conn: sqlite3.Connection, warnings: list[dict[str, str]]) -> dict[str, dict[str, str]]:
    trip_extra_columns = [
        "fuel_surcharge",
        "loading_fee",
        "unloading_fee",
        "waiting_fee",
        "tolls",
        "additional_stop_charge",
        "special_handling_fee",
        "other_charges",
    ]
    trip_extra_expr = " + ".join([f"COALESCE({column}, 0)" for column in trip_extra_columns])
    trips_base = decimal_sum(conn, "core_trip", "COALESCE(base_trip_rate, 0)")
    trips_extra = decimal_sum(conn, "core_trip", trip_extra_expr) if table_exists(conn, "core_trip") else MONEY_ZERO

    payroll_deduction_expr = " + ".join(
        [
            "COALESCE(vale_deduction, 0)",
            "COALESCE(cash_advance_deduction, 0)",
            "COALESCE(sss, 0)",
            "COALESCE(philhealth, 0)",
            "COALESCE(pagibig, 0)",
            "COALESCE(withholding_tax, 0)",
            "COALESCE(change_deduction, 0)",
            "COALESCE(other_deduction, 0)",
        ]
    )

    for table in (
        "core_trip",
        "core_payrollentry",
        "core_billingstatement",
        "core_collection",
        "core_payable",
        "core_valerecord",
        "core_cashadvance",
    ):
        if not table_exists(conn, table):
            add_warning(warnings, "missing_financial_table", f"Financial totals skipped missing table {table}.")

    billing_total = decimal_sum(conn, "core_billingstatement", "COALESCE(grand_total, 0)")
    collections_total = decimal_sum(conn, "core_collection", "COALESCE(amount_paid, 0)")

    return {
        "trips": {
            "base_total": str(trips_base),
            "extra_total": str(trips_extra),
            "billable_total": str((trips_base + trips_extra).quantize(MONEY_ZERO)),
        },
        "payroll": {
            "gross_total": str(decimal_sum(conn, "core_payrollentry", "COALESCE(gross_pay, 0)")),
            "additional_total": str(decimal_sum(conn, "core_payrollentry", "COALESCE(additional_pay, 0)")),
            "deduction_total": str(decimal_sum(conn, "core_payrollentry", payroll_deduction_expr)),
            "net_total": str(decimal_sum(conn, "core_payrollentry", "COALESCE(net_pay, 0)")),
        },
        "billing": {
            "grand_total": str(billing_total),
            "collections_total": str(collections_total),
            "receivable_balance": str((billing_total - collections_total).quantize(MONEY_ZERO)),
        },
        "payables": {
            "open_total": str(
                decimal_sum(
                    conn,
                    "core_payable",
                    "COALESCE(amount, 0)",
                    "LOWER(COALESCE(status, '')) IN ('open', 'partially paid', 'partial')",
                )
            ),
        },
        "advances": {
            "open_vale_balance": str(
                decimal_sum(conn, "core_valerecord", "COALESCE(balance, 0)", "LOWER(COALESCE(status, '')) = 'open'")
            ),
            "open_cash_advance_balance": str(
                decimal_sum(conn, "core_cashadvance", "COALESCE(balance, 0)", "LOWER(COALESCE(status, '')) = 'open'")
            ),
        },
    }


def build_export(source: Path, include_users: bool = False) -> tuple[str, dict[str, Any]]:
    if not source.exists():
        raise FileNotFoundError(f"Source SQLite database does not exist: {source}")

    warnings: list[dict[str, str]] = []
    table_specs = dict(TABLES)
    if include_users:
        table_specs.update(USER_TABLES)

    sql_lines = [
        "-- GMT Trucking Django SQLite to Cloudflare D1 import",
        f"-- Generated at {datetime.now(timezone.utc).isoformat()}",
        "-- This file uses INSERT OR REPLACE and does not wipe existing D1 rows.",
        "PRAGMA foreign_keys=OFF;",
        "BEGIN TRANSACTION;",
    ]
    tables_manifest: list[dict[str, Any]] = []
    row_counts: dict[str, int] = {}
    mapping: dict[str, str] = {}

    with connect_readonly(source) as conn:
        for source_table, (target_table, requested_columns) in table_specs.items():
            mapping[source_table] = target_table

            if not table_exists(conn, source_table):
                add_warning(warnings, "missing_table", f"Source table {source_table} was not found; {target_table} was skipped.")
                tables_manifest.append(
                    {
                        "source": source_table,
                        "target": target_table,
                        "columns": [],
                        "row_count": 0,
                        "missing": True,
                        "missing_columns": requested_columns,
                    }
                )
                row_counts[target_table] = 0
                continue

            existing_columns = table_columns(conn, source_table)
            export_columns = [column for column in requested_columns if column in existing_columns]
            missing_columns = [column for column in requested_columns if column not in existing_columns]
            if missing_columns:
                add_warning(
                    warnings,
                    "missing_columns",
                    f"Source table {source_table} is missing columns for {target_table}: {', '.join(missing_columns)}.",
                )
            if not export_columns:
                add_warning(warnings, "empty_column_mapping", f"No compatible columns were found for {source_table}; skipped.")
                tables_manifest.append(
                    {
                        "source": source_table,
                        "target": target_table,
                        "columns": [],
                        "row_count": count_rows(conn, source_table),
                        "missing": False,
                        "missing_columns": missing_columns,
                    }
                )
                row_counts[target_table] = 0
                continue

            quoted_columns = ", ".join([f'"{column}"' for column in export_columns])
            sql_lines.append(f"\n-- {source_table} -> {target_table}")
            row_count = 0
            for row in conn.execute(f'SELECT {quoted_columns} FROM "{source_table}" ORDER BY rowid'):
                values = ", ".join(sql_literal(row[column]) for column in export_columns)
                target_columns = ", ".join([f'"{column}"' for column in export_columns])
                sql_lines.append(f'INSERT OR REPLACE INTO "{target_table}" ({target_columns}) VALUES ({values});')
                row_count += 1

            tables_manifest.append(
                {
                    "source": source_table,
                    "target": target_table,
                    "columns": export_columns,
                    "row_count": row_count,
                    "missing": False,
                    "missing_columns": missing_columns,
                }
            )
            row_counts[target_table] = row_count

        if include_users:
            add_warning(
                warnings,
                "users_included_testing_only",
                "User rows were included because --include-users was passed. Use only for non-production/testing.",
            )
        else:
            add_warning(
                warnings,
                "users_skipped",
                "Application users and credentials are excluded by default; create or reset real users in User Management.",
            )

        financial_totals = collect_financial_totals(conn, warnings)

    sql_lines.extend(["COMMIT;", "PRAGMA foreign_keys=ON;", ""])
    generated_at = datetime.now(timezone.utc).isoformat()
    manifest: dict[str, Any] = {
        "generated_at": generated_at,
        "source": {
            "path": str(source),
            "sha256": sha256_file(source),
        },
        "options": {
            "users_included": include_users,
            "credentials_excluded": not include_users,
            "destructive_replace": False,
        },
        "table_mapping": mapping,
        "tables": tables_manifest,
        "row_counts": row_counts,
        "warnings": warnings,
        "financial_control_totals": financial_totals,
        "import_instructions": [
            "Download a D1 backup first from /data-tools/export.json.",
            "Use a fresh D1 database or manually confirm a safe cleanup before production import.",
            "Apply SQL with: npx wrangler d1 execute gmt-trucking --remote --file=./import.sql",
            "Reopen /data-tools and compare D1 row counts/control totals against this manifest.",
            "Manage real Cloudflare users in User Management instead of importing Django auth users.",
        ],
    }
    return "\n".join(sql_lines), manifest


def write_text_file(path_text: str, content: str) -> None:
    path = Path(path_text)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    source = Path(args.source)
    sql_text, manifest = build_export(source, include_users=args.include_users)

    if args.summary_json:
        write_text_file(args.summary_json, json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    if args.dry_run:
        print("Dry run complete. No SQL was written.")
        print(f"Source: {manifest['source']['path']}")
        print(f"SHA-256: {manifest['source']['sha256']}")
        print(f"Mapped tables: {len(manifest['table_mapping'])}")
        print(f"Warnings: {len(manifest['warnings'])}")
        if args.output_sql:
            print(f"Skipped SQL output because --dry-run was used: {args.output_sql}")
        return 0

    if args.output_sql:
        write_text_file(args.output_sql, sql_text)
    else:
        sys.stdout.write(sql_text)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
