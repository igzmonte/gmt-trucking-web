PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK(role IN ('admin','encoder','viewer','accounting')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_code TEXT UNIQUE,
  full_name TEXT NOT NULL,
  employee_type TEXT NOT NULL,
  contact_no TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  date_hired TEXT,
  employment_status TEXT NOT NULL DEFAULT 'Active',
  payroll_basis TEXT NOT NULL DEFAULT 'Per Trip',
  daily_rate NUMERIC NOT NULL DEFAULT 0,
  trip_rate NUMERIC NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_code TEXT NOT NULL UNIQUE,
  asset_type TEXT NOT NULL,
  plate_no TEXT NOT NULL DEFAULT '',
  make_model TEXT NOT NULL DEFAULT '',
  capacity_desc TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Available',
  assigned_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_code TEXT UNIQUE,
  client_name TEXT NOT NULL UNIQUE,
  billing_address TEXT NOT NULL DEFAULT '',
  contact_person TEXT NOT NULL DEFAULT '',
  contact_no TEXT NOT NULL DEFAULT '',
  terms_days INTEGER NOT NULL DEFAULT 30,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_name TEXT NOT NULL UNIQUE,
  contact_person TEXT NOT NULL DEFAULT '',
  contact_no TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS recurring_trip_masters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  master_code TEXT UNIQUE,
  client_id INTEGER REFERENCES clients(id) ON DELETE RESTRICT,
  job_description TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL DEFAULT '',
  default_asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
  default_driver_id INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
  default_helper_count INTEGER NOT NULL DEFAULT 0,
  standard_base_rate NUMERIC NOT NULL DEFAULT 0,
  driver_pay_rate NUMERIC NOT NULL DEFAULT 0,
  helper_pay_rate NUMERIC NOT NULL DEFAULT 0,
  default_extra_note TEXT NOT NULL DEFAULT '',
  remarks TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_ticket_no TEXT NOT NULL UNIQUE,
  reference_no TEXT NOT NULL DEFAULT '',
  trip_type TEXT NOT NULL,
  recurring_master_id INTEGER REFERENCES recurring_trip_masters(id) ON DELETE SET NULL,
  trip_date TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE RESTRICT,
  job_description TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL DEFAULT '',
  asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
  driver_id INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
  dispatch_time TEXT,
  arrival_time TEXT,
  status TEXT NOT NULL DEFAULT 'Planned',
  base_trip_rate NUMERIC NOT NULL DEFAULT 0,
  driver_pay_rate NUMERIC NOT NULL DEFAULT 0,
  helper_pay_rate NUMERIC NOT NULL DEFAULT 0,
  driver_additional_pay NUMERIC NOT NULL DEFAULT 0,
  helper_additional_pay NUMERIC NOT NULL DEFAULT 0,
  fuel_surcharge NUMERIC NOT NULL DEFAULT 0,
  loading_fee NUMERIC NOT NULL DEFAULT 0,
  unloading_fee NUMERIC NOT NULL DEFAULT 0,
  waiting_fee NUMERIC NOT NULL DEFAULT 0,
  tolls NUMERIC NOT NULL DEFAULT 0,
  additional_stop_charge NUMERIC NOT NULL DEFAULT 0,
  special_handling_fee NUMERIC NOT NULL DEFAULT 0,
  other_charges NUMERIC NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS trip_helpers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  helper_order INTEGER NOT NULL DEFAULT 1,
  UNIQUE(trip_id, employee_id),
  UNIQUE(trip_id, helper_order)
);

CREATE TABLE IF NOT EXISTS trip_employee_pay_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  employee_type TEXT NOT NULL,
  label TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS repairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repair_date TEXT NOT NULL,
  asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
  repair_description TEXT NOT NULL,
  meter_value TEXT NOT NULL DEFAULT '',
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE RESTRICT,
  parts_cost NUMERIC NOT NULL DEFAULT 0,
  labor_cost NUMERIC NOT NULL DEFAULT 0,
  other_cost NUMERIC NOT NULL DEFAULT 0,
  total_cost NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Open',
  notes TEXT NOT NULL DEFAULT '',
  auto_generate_payable INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payable_date TEXT NOT NULL,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL DEFAULT '',
  reference_no TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  amount NUMERIC NOT NULL DEFAULT 0,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'Open',
  notes TEXT NOT NULL DEFAULT '',
  linked_repair_id INTEGER UNIQUE REFERENCES repairs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS vale_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  date_granted TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  installment_amount NUMERIC NOT NULL DEFAULT 0,
  balance NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Open',
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cash_advances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  date_granted TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  balance NUMERIC NOT NULL DEFAULT 0,
  applied INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Open',
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS payroll_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pay_date TEXT NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  employee_type TEXT NOT NULL DEFAULT '',
  payroll_basis TEXT NOT NULL DEFAULT '',
  unit_description TEXT NOT NULL DEFAULT '',
  trips_count INTEGER NOT NULL DEFAULT 0,
  days_count NUMERIC NOT NULL DEFAULT 0,
  gross_pay NUMERIC NOT NULL DEFAULT 0,
  additional_pay NUMERIC NOT NULL DEFAULT 0,
  driver_trip_additional_pay NUMERIC NOT NULL DEFAULT 0,
  helper_trip_additional_pay NUMERIC NOT NULL DEFAULT 0,
  vale_deduction NUMERIC NOT NULL DEFAULT 0,
  cash_advance_deduction NUMERIC NOT NULL DEFAULT 0,
  sss NUMERIC NOT NULL DEFAULT 0,
  philhealth NUMERIC NOT NULL DEFAULT 0,
  pagibig NUMERIC NOT NULL DEFAULT 0,
  withholding_tax NUMERIC NOT NULL DEFAULT 0,
  change_deduction NUMERIC NOT NULL DEFAULT 0,
  other_deduction NUMERIC NOT NULL DEFAULT 0,
  net_pay NUMERIC NOT NULL DEFAULT 0,
  remarks TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS payroll_trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payroll_id INTEGER NOT NULL REFERENCES payroll_entries(id) ON DELETE CASCADE,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE RESTRICT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  UNIQUE(payroll_id, trip_id),
  UNIQUE(employee_id, trip_id)
);

CREATE TABLE IF NOT EXISTS payroll_additional_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payroll_id INTEGER NOT NULL REFERENCES payroll_entries(id) ON DELETE CASCADE,
  employee_type TEXT NOT NULL,
  label TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS billing_statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  billing_no TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  billing_date TEXT NOT NULL,
  period_from TEXT,
  period_to TEXT,
  base_charges_total NUMERIC NOT NULL DEFAULT 0,
  extra_charges_total NUMERIC NOT NULL DEFAULT 0,
  gross_total NUMERIC NOT NULL DEFAULT 0,
  vat_enabled INTEGER NOT NULL DEFAULT 0,
  vat_amount NUMERIC NOT NULL DEFAULT 0,
  additions_total NUMERIC NOT NULL DEFAULT 0,
  deductions_total NUMERIC NOT NULL DEFAULT 0,
  grand_total NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Open',
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS billing_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  billing_id INTEGER NOT NULL REFERENCES billing_statements(id) ON DELETE CASCADE,
  trip_id INTEGER NOT NULL UNIQUE REFERENCES trips(id) ON DELETE RESTRICT,
  amount_base NUMERIC NOT NULL DEFAULT 0,
  amount_extra NUMERIC NOT NULL DEFAULT 0,
  amount_total NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS billing_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  billing_id INTEGER NOT NULL REFERENCES billing_statements(id) ON DELETE CASCADE,
  line_type TEXT NOT NULL,
  label TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_date TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE RESTRICT,
  billing_id INTEGER REFERENCES billing_statements(id) ON DELETE RESTRICT,
  amount_paid NUMERIC NOT NULL DEFAULT 0,
  reference_no TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_trips_date_status ON trips(trip_date, status);
CREATE INDEX IF NOT EXISTS idx_trips_client ON trips(client_id);
CREATE INDEX IF NOT EXISTS idx_billing_client_status ON billing_statements(client_id, status);
CREATE INDEX IF NOT EXISTS idx_collections_billing ON collections(billing_id);
CREATE INDEX IF NOT EXISTS idx_payroll_employee_trip ON payroll_trips(employee_id, trip_id);
