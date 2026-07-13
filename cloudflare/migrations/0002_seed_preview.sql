INSERT OR IGNORE INTO users (id, username, password_hash, first_name, last_name, email, role, active)
VALUES
  (1, 'test_admin', 'pbkdf2_sha256$260000$Z210LXByZXZpZXctc2FsdA$q4DiTWXE27jvichAjIxrLwGXto8xV0NX5i4P_awNFSk', 'Test', 'Admin', 'admin@example.invalid', 'admin', 1),
  (2, 'test_encoder', 'pbkdf2_sha256$260000$Z210LXByZXZpZXctc2FsdA$q4DiTWXE27jvichAjIxrLwGXto8xV0NX5i4P_awNFSk', 'Test', 'Encoder', 'encoder@example.invalid', 'encoder', 1),
  (3, 'test_viewer', 'pbkdf2_sha256$260000$Z210LXByZXZpZXctc2FsdA$q4DiTWXE27jvichAjIxrLwGXto8xV0NX5i4P_awNFSk', 'Test', 'Viewer', 'viewer@example.invalid', 'viewer', 1),
  (4, 'test_accounting', 'pbkdf2_sha256$260000$Z210LXByZXZpZXctc2FsdA$q4DiTWXE27jvichAjIxrLwGXto8xV0NX5i4P_awNFSk', 'Test', 'Accounting', 'accounting@example.invalid', 'accounting', 1);

INSERT OR IGNORE INTO employees (id, employee_code, full_name, employee_type, employment_status, payroll_basis, daily_rate, trip_rate, active)
VALUES
  (1, 'EMP-001', 'Sample Driver One', 'Driver', 'Active', 'Per Trip', 0, 850, 1),
  (2, 'EMP-002', 'Sample Helper One', 'Helper', 'Active', 'Per Trip', 0, 450, 1),
  (3, 'EMP-003', 'Sample Operator One', 'Operator', 'Active', 'Per Day', 800, 0, 1);

INSERT OR IGNORE INTO clients (id, client_code, client_name, billing_address, contact_person, contact_no, terms_days, active)
VALUES (1, 'CLI-001', 'Sample Client Corporation', '100 Example Avenue, Sample City', 'Sample Contact', '+63 900 000 0000', 30, 1);

INSERT OR IGNORE INTO suppliers (id, supplier_name, contact_person, contact_no, address)
VALUES (1, 'Sample Parts Supplier', 'Sample Supplier Contact', '+63 900 000 0001', '200 Example Road, Sample City');

INSERT OR IGNORE INTO assets (id, asset_code, asset_type, plate_no, make_model, status, assigned_employee_id)
VALUES (1, 'TRK-001', 'Cargo Truck', 'SAMPLE-01', 'Sample Cargo Truck', 'In Use', 1);

INSERT OR IGNORE INTO recurring_trip_masters (id, master_code, client_id, job_description, origin, destination, default_asset_id, default_driver_id, default_helper_count, standard_base_rate, driver_pay_rate, helper_pay_rate, active)
VALUES (1, 'REC-001', 1, 'Synthetic recurring delivery', 'Sample Warehouse', 'Sample Delivery Hub', 1, 1, 1, 12500, 850, 450, 1);

INSERT OR IGNORE INTO trips (id, trip_ticket_no, reference_no, trip_type, recurring_master_id, trip_date, client_id, job_description, origin, destination, asset_id, driver_id, status, base_trip_rate, driver_pay_rate, helper_pay_rate)
VALUES
  (1, 'TT-2026-0001', 'SAMPLE-REF-001', 'Spot Trip', NULL, '2026-01-15', 1, 'Synthetic hosted preview delivery', 'Sample Warehouse', 'Sample Delivery Hub', 1, 1, 'Ongoing', 12500, 850, 450),
  (2, 'TT-2026-0002', '', 'Spot Trip', NULL, '2026-01-14', 1, 'Synthetic completed delivery', 'Sample Port', 'Sample Depot', 1, 1, 'Completed', 10000, 850, 450),
  (3, 'TT-2026-0003', 'SAMPLE-RECEIPT-001', 'Spot Trip', NULL, '2026-01-10', 1, 'Synthetic billed delivery', 'Sample Depot', 'Sample Customer Site', 1, 1, 'Billed', 15000, 850, 450);

INSERT OR IGNORE INTO trip_helpers (trip_id, employee_id, helper_order) VALUES (1, 2, 1), (2, 2, 1), (3, 2, 1);

INSERT OR IGNORE INTO billing_statements (id, billing_no, client_id, billing_date, period_from, period_to, base_charges_total, gross_total, grand_total, status, notes)
VALUES (1, 'BILL-2026-0001', 1, '2026-01-12', '2026-01-01', '2026-01-15', 15000, 15000, 15000, 'Partially Paid', 'Synthetic hosted preview billing');

INSERT OR IGNORE INTO billing_lines (billing_id, trip_id, amount_base, amount_extra, amount_total)
VALUES (1, 3, 15000, 0, 15000);

INSERT OR IGNORE INTO collections (collection_date, client_id, billing_id, amount_paid, reference_no, payment_method)
VALUES ('2026-01-20', 1, 1, 5000, 'SAMPLE-RECEIPT-001', 'Bank Transfer');
