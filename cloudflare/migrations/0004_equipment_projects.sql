PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_no TEXT NOT NULL UNIQUE,
  reference_no TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL,
  end_date TEXT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  job_description TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL DEFAULT '',
  project_location TEXT NOT NULL DEFAULT '',
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  primary_employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  billing_basis TEXT NOT NULL CHECK(billing_basis IN ('Trip','Hour','Day')),
  default_billing_quantity NUMERIC NOT NULL DEFAULT 1,
  client_unit_rate NUMERIC NOT NULL DEFAULT 0,
  primary_pay_basis TEXT NOT NULL CHECK(primary_pay_basis IN ('Per Trip','Per Hour','Per Day','Manual')),
  primary_pay_rate NUMERIC NOT NULL DEFAULT 0,
  helper_pay_basis TEXT NOT NULL CHECK(helper_pay_basis IN ('Per Trip','Per Hour','Per Day','Manual')),
  helper_pay_rate NUMERIC NOT NULL DEFAULT 0,
  fuel_surcharge NUMERIC NOT NULL DEFAULT 0,
  loading_fee NUMERIC NOT NULL DEFAULT 0,
  unloading_fee NUMERIC NOT NULL DEFAULT 0,
  waiting_fee NUMERIC NOT NULL DEFAULT 0,
  tolls NUMERIC NOT NULL DEFAULT 0,
  additional_stop_charge NUMERIC NOT NULL DEFAULT 0,
  special_handling_fee NUMERIC NOT NULL DEFAULT 0,
  other_charges NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Active','Completed','Cancelled')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_helpers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  helper_order INTEGER NOT NULL DEFAULT 1,
  UNIQUE(project_id, employee_id),
  UNIQUE(project_id, helper_order)
);

CREATE TABLE IF NOT EXISTS project_pay_item_defaults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  employee_type TEXT NOT NULL CHECK(employee_type IN ('Primary','Helper')),
  label TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS project_work_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_no TEXT NOT NULL UNIQUE,
  work_date TEXT NOT NULL,
  reference_no TEXT NOT NULL DEFAULT '',
  billing_unit TEXT NOT NULL CHECK(billing_unit IN ('Trip','Hour','Day')),
  billing_quantity NUMERIC NOT NULL DEFAULT 0,
  client_unit_rate NUMERIC NOT NULL DEFAULT 0,
  base_charge NUMERIC NOT NULL DEFAULT 0,
  primary_employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  primary_pay_basis TEXT NOT NULL,
  primary_pay_quantity NUMERIC NOT NULL DEFAULT 0,
  primary_pay_rate NUMERIC NOT NULL DEFAULT 0,
  primary_manual_pay NUMERIC NOT NULL DEFAULT 0,
  helper_pay_basis TEXT NOT NULL,
  helper_pay_quantity NUMERIC NOT NULL DEFAULT 0,
  helper_pay_rate NUMERIC NOT NULL DEFAULT 0,
  helper_manual_pay NUMERIC NOT NULL DEFAULT 0,
  client_id_snapshot INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  asset_id_snapshot INTEGER NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  job_description_snapshot TEXT NOT NULL DEFAULT '',
  origin_snapshot TEXT NOT NULL DEFAULT '',
  destination_snapshot TEXT NOT NULL DEFAULT '',
  project_location_snapshot TEXT NOT NULL DEFAULT '',
  start_time TEXT,
  end_time TEXT,
  meter_start NUMERIC,
  meter_end NUMERIC,
  fuel_surcharge NUMERIC NOT NULL DEFAULT 0,
  loading_fee NUMERIC NOT NULL DEFAULT 0,
  unloading_fee NUMERIC NOT NULL DEFAULT 0,
  waiting_fee NUMERIC NOT NULL DEFAULT 0,
  tolls NUMERIC NOT NULL DEFAULT 0,
  additional_stop_charge NUMERIC NOT NULL DEFAULT 0,
  special_handling_fee NUMERIC NOT NULL DEFAULT 0,
  other_charges NUMERIC NOT NULL DEFAULT 0,
  extra_total NUMERIC NOT NULL DEFAULT 0,
  total_charge NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Completed','Cancelled','Billed')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_work_helpers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_entry_id INTEGER NOT NULL REFERENCES project_work_entries(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  helper_order INTEGER NOT NULL DEFAULT 1,
  UNIQUE(work_entry_id, employee_id),
  UNIQUE(work_entry_id, helper_order)
);

CREATE TABLE IF NOT EXISTS project_work_pay_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_entry_id INTEGER NOT NULL REFERENCES project_work_entries(id) ON DELETE CASCADE,
  employee_type TEXT NOT NULL CHECK(employee_type IN ('Primary','Helper')),
  label TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS billing_project_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  billing_id INTEGER NOT NULL REFERENCES billing_statements(id) ON DELETE CASCADE,
  work_entry_id INTEGER NOT NULL UNIQUE REFERENCES project_work_entries(id) ON DELETE RESTRICT,
  amount_base NUMERIC NOT NULL DEFAULT 0,
  amount_extra NUMERIC NOT NULL DEFAULT 0,
  amount_total NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payroll_project_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payroll_id INTEGER NOT NULL REFERENCES payroll_entries(id) ON DELETE CASCADE,
  work_entry_id INTEGER NOT NULL REFERENCES project_work_entries(id) ON DELETE RESTRICT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  employee_role TEXT NOT NULL CHECK(employee_role IN ('Primary','Helper')),
  pay_basis TEXT NOT NULL,
  pay_quantity NUMERIC NOT NULL DEFAULT 0,
  pay_rate NUMERIC NOT NULL DEFAULT 0,
  base_amount NUMERIC NOT NULL DEFAULT 0,
  UNIQUE(payroll_id, work_entry_id, employee_id),
  UNIQUE(employee_id, work_entry_id)
);

CREATE INDEX IF NOT EXISTS idx_projects_client_dates ON projects(client_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_projects_asset ON projects(asset_id);
CREATE INDEX IF NOT EXISTS idx_project_work_project_date ON project_work_entries(project_id, work_date);
CREATE INDEX IF NOT EXISTS idx_project_work_client_date ON project_work_entries(client_id_snapshot, work_date);
CREATE INDEX IF NOT EXISTS idx_project_work_primary_date ON project_work_entries(primary_employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_project_helpers_employee ON project_helpers(employee_id);
CREATE INDEX IF NOT EXISTS idx_project_work_helpers_employee ON project_work_helpers(employee_id);
CREATE INDEX IF NOT EXISTS idx_billing_project_billing ON billing_project_lines(billing_id);
CREATE INDEX IF NOT EXISTS idx_payroll_project_payroll ON payroll_project_entries(payroll_id);
