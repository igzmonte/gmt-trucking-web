import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "cloudflare" / "tools" / "export_django_sqlite_to_d1.py"


class ExportDjangoSqliteToD1Tests(unittest.TestCase):
    def make_db(self, minimal=False):
        tmp = tempfile.TemporaryDirectory()
        path = Path(tmp.name) / "source.sqlite3"
        conn = sqlite3.connect(path)
        conn.execute(
            """
            CREATE TABLE core_employee (
              id INTEGER PRIMARY KEY,
              employee_code TEXT,
              full_name TEXT,
              employee_type TEXT,
              contact_no TEXT,
              address TEXT,
              date_hired TEXT,
              employment_status TEXT,
              payroll_basis TEXT,
              daily_rate REAL,
              trip_rate REAL,
              notes TEXT,
              active INTEGER
            )
            """
        )
        conn.execute(
            """
            INSERT INTO core_employee
            VALUES (1, 'EMP-000001', 'Juan Tester', 'Driver', '', '', '2026-01-01', 'Active', 'Per Trip', 0, 500, '', 1)
            """
        )

        if not minimal:
            conn.execute(
                """
                CREATE TABLE core_trip (
                  id INTEGER PRIMARY KEY,
                  trip_ticket_no TEXT,
                  reference_no TEXT,
                  trip_type TEXT,
                  recurring_master_id INTEGER,
                  trip_date TEXT,
                  client_id INTEGER,
                  job_description TEXT,
                  origin TEXT,
                  destination TEXT,
                  asset_id INTEGER,
                  driver_id INTEGER,
                  dispatch_time TEXT,
                  arrival_time TEXT,
                  status TEXT,
                  base_trip_rate REAL,
                  driver_pay_rate REAL,
                  helper_pay_rate REAL,
                  driver_additional_pay REAL,
                  helper_additional_pay REAL,
                  fuel_surcharge REAL,
                  loading_fee REAL,
                  unloading_fee REAL,
                  waiting_fee REAL,
                  tolls REAL,
                  additional_stop_charge REAL,
                  special_handling_fee REAL,
                  other_charges REAL,
                  notes TEXT
                )
                """
            )
            conn.execute(
                """
                INSERT INTO core_trip VALUES (
                  10, 'TT-1', 'REF-1', 'Spot Trip', NULL, '2026-07-01', 1,
                  'Blocks', 'A', 'B', 1, 1, NULL, NULL, 'Completed',
                  1000, 200, 100, 0, 0, 50, 20, 30, 0, 10, 0, 0, 5, ''
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE core_payrollentry (
                  id INTEGER PRIMARY KEY,
                  pay_date TEXT,
                  period_from TEXT,
                  period_to TEXT,
                  employee_id INTEGER,
                  employee_type TEXT,
                  payroll_basis TEXT,
                  unit_description TEXT,
                  trips_count INTEGER,
                  days_count REAL,
                  gross_pay REAL,
                  additional_pay REAL,
                  driver_trip_additional_pay REAL,
                  helper_trip_additional_pay REAL,
                  vale_deduction REAL,
                  cash_advance_deduction REAL,
                  sss REAL,
                  philhealth REAL,
                  pagibig REAL,
                  withholding_tax REAL,
                  change_deduction REAL,
                  other_deduction REAL,
                  net_pay REAL,
                  remarks TEXT
                )
                """
            )
            conn.execute(
                """
                INSERT INTO core_payrollentry VALUES (
                  1, '2026-07-05', '2026-07-01', '2026-07-05', 1, 'Driver', 'Per Trip',
                  '1 trip', 1, 0, 500, 25, 25, 0, 100, 50, 10, 5, 5, 20, 0, 0, 335, ''
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE core_billingstatement (
                  id INTEGER PRIMARY KEY,
                  billing_no TEXT,
                  client_id INTEGER,
                  billing_date TEXT,
                  period_from TEXT,
                  period_to TEXT,
                  base_charges_total REAL,
                  extra_charges_total REAL,
                  gross_total REAL,
                  vat_enabled INTEGER,
                  vat_amount REAL,
                  additions_total REAL,
                  deductions_total REAL,
                  grand_total REAL,
                  status TEXT,
                  notes TEXT
                )
                """
            )
            conn.execute(
                "INSERT INTO core_billingstatement VALUES (1, 'BILL-1', 1, '2026-07-05', '2026-07-01', '2026-07-05', 1000, 115, 1115, 0, 0, 0, 0, 1115, 'Open', '')"
            )
            conn.execute(
                """
                CREATE TABLE core_collection (
                  id INTEGER PRIMARY KEY,
                  collection_date TEXT,
                  client_id INTEGER,
                  billing_id INTEGER,
                  amount_paid REAL,
                  reference_no TEXT,
                  payment_method TEXT,
                  notes TEXT
                )
                """
            )
            conn.execute("INSERT INTO core_collection VALUES (1, '2026-07-06', 1, 1, 400, 'OR-1', 'Cash', '')")
            conn.execute(
                """
                CREATE TABLE core_payable (
                  id INTEGER PRIMARY KEY,
                  payable_date TEXT,
                  supplier_id INTEGER,
                  source_type TEXT,
                  reference_no TEXT,
                  description TEXT,
                  amount REAL,
                  due_date TEXT,
                  status TEXT,
                  notes TEXT,
                  linked_repair_id INTEGER
                )
                """
            )
            conn.execute("INSERT INTO core_payable VALUES (1, '2026-07-01', 1, 'Manual', 'P-1', 'Parts', 300, NULL, 'Open', '', NULL)")
            conn.execute(
                """
                CREATE TABLE core_valerecord (
                  id INTEGER PRIMARY KEY,
                  employee_id INTEGER,
                  date_granted TEXT,
                  amount REAL,
                  installment_amount REAL,
                  balance REAL,
                  status TEXT,
                  notes TEXT
                )
                """
            )
            conn.execute("INSERT INTO core_valerecord VALUES (1, 1, '2026-07-01', 200, 50, 150, 'Open', '')")
            conn.execute(
                """
                CREATE TABLE core_cashadvance (
                  id INTEGER PRIMARY KEY,
                  employee_id INTEGER,
                  date_granted TEXT,
                  amount REAL,
                  balance REAL,
                  applied INTEGER,
                  status TEXT,
                  notes TEXT
                )
                """
            )
            conn.execute("INSERT INTO core_cashadvance VALUES (1, 1, '2026-07-01', 500, 450, 0, 'Open', '')")
            conn.execute(
                """
                CREATE TABLE users (
                  id INTEGER PRIMARY KEY,
                  username TEXT,
                  password_hash TEXT,
                  first_name TEXT,
                  last_name TEXT,
                  email TEXT,
                  role TEXT,
                  active INTEGER,
                  created_at TEXT
                )
                """
            )
            conn.execute(
                "INSERT INTO users VALUES (1, 'demo', 'hash-for-tests', 'Demo', 'User', 'demo@example.com', 'Admin', 1, '2026-07-01T00:00:00Z')"
            )

        conn.commit()
        conn.close()
        return tmp, path

    def run_script(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *map(str, args)],
            check=True,
            text=True,
            capture_output=True,
        )

    def test_stdout_sql_generation_remains_backward_compatible(self):
        tmp, db_path = self.make_db()
        self.addCleanup(tmp.cleanup)

        result = self.run_script(db_path)

        self.assertIn("PRAGMA foreign_keys=OFF;", result.stdout)
        self.assertIn('INSERT OR REPLACE INTO "employees"', result.stdout)
        self.assertIn("Juan Tester", result.stdout)
        self.assertNotIn('INSERT OR REPLACE INTO "users"', result.stdout)

    def test_output_sql_and_summary_json_include_counts_hash_and_controls(self):
        tmp, db_path = self.make_db()
        self.addCleanup(tmp.cleanup)
        sql_path = Path(tmp.name) / "import.sql"
        manifest_path = Path(tmp.name) / "manifest.json"

        self.run_script(db_path, "--output-sql", sql_path, "--summary-json", manifest_path)

        self.assertIn('INSERT OR REPLACE INTO "trips"', sql_path.read_text(encoding="utf-8"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["row_counts"]["employees"], 1)
        self.assertEqual(manifest["row_counts"]["trips"], 1)
        self.assertRegex(manifest["source"]["sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(manifest["financial_control_totals"]["trips"]["billable_total"], "1115.00")
        self.assertFalse(manifest["options"]["users_included"])
        self.assertTrue(manifest["options"]["credentials_excluded"])

    def test_dry_run_writes_manifest_but_no_sql_file(self):
        tmp, db_path = self.make_db()
        self.addCleanup(tmp.cleanup)
        sql_path = Path(tmp.name) / "dry.sql"
        manifest_path = Path(tmp.name) / "dry-manifest.json"

        result = self.run_script(db_path, "--dry-run", "--output-sql", sql_path, "--summary-json", manifest_path)

        self.assertIn("Dry run complete", result.stdout)
        self.assertFalse(sql_path.exists())
        self.assertTrue(manifest_path.exists())
        self.assertNotIn("INSERT OR REPLACE", result.stdout)

    def test_missing_optional_tables_are_warnings_not_failures(self):
        tmp, db_path = self.make_db(minimal=True)
        self.addCleanup(tmp.cleanup)
        manifest_path = Path(tmp.name) / "manifest.json"

        self.run_script(db_path, "--summary-json", manifest_path, "--dry-run")

        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        warning_codes = {warning["code"] for warning in manifest["warnings"]}
        self.assertIn("missing_table", warning_codes)
        self.assertEqual(manifest["row_counts"]["employees"], 1)
        self.assertEqual(manifest["row_counts"]["trips"], 0)

    def test_include_users_is_explicit_and_testing_only(self):
        tmp, db_path = self.make_db()
        self.addCleanup(tmp.cleanup)
        manifest_path = Path(tmp.name) / "manifest.json"

        result = self.run_script(db_path, "--include-users", "--summary-json", manifest_path)

        self.assertIn('INSERT OR REPLACE INTO "users"', result.stdout)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertTrue(manifest["options"]["users_included"])
        self.assertFalse(manifest["options"]["credentials_excluded"])
        self.assertTrue(any(warning["code"] == "users_included_testing_only" for warning in manifest["warnings"]))


if __name__ == "__main__":
    unittest.main()
