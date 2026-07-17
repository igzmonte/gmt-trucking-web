# GMT Cloudflare staged live-use procedure

Use this procedure for controlled staff testing with sanitized or test data. It
does not authorize production-data import.

## Before sharing the app

1. In Cloudflare Workers & Pages, set `GMT_SESSION_SECRET` as an encrypted
   secret. Use a unique random value of at least 32 characters. Do not use the
   placeholder value from `wrangler.toml`.
2. Sign in as an Admin. Open `/settings` and confirm the company profile,
   company logo, document footer text, VAT default, and prepared/checked names.
3. Open `/data-tools`, download `/data-tools/export.json`, and store the file
   outside the Git repository.
4. Open `/data-tools/checklist`. Resolve every **Blocked** item. Review every
   **Attention Needed** item before inviting staff.
5. In User Management, create separate test accounts for Encoder, Viewer, and
   Accounting. Reset or deactivate `test_admin` before anyone outside the test
   team can access the app.

## Required staged workflow test

Perform this in a test client/account set. Use identifiable test labels so they
can be removed later without touching real records.

1. Create, edit, export, and safely delete one Employee, Fleet/Equipment item,
   Client, and Supplier.
2. Create one Recurring Trip template and one Spot Trip. Confirm detailed
   dropdown labels, helper-limit guidance, item/job, reference number, and
   printable Trip Ticket / Waybill.
3. Record one Repair, one linked/manual Payable, one Vale record, and one Cash
   Advance. Confirm totals and exports.
4. Create a Payroll entry, verify claimed trips and deductions, print the
   payslip, then delete/reverse it and verify claimed trips and advance balances
   are restored.
5. Create a Billing Statement from completed trips, add a Collection, verify
   the billing status/balance, print the Billing Statement, and generate/print
   a Statement of Account.
6. Load, print, and export a report. Confirm company logo/header appears on
   Trip Ticket, Billing, SOA, and Reports, but not Payslip.
7. Sign in as Viewer and Accounting to confirm the role restrictions. Viewer is
   read-only; Accounting has finance access only.
8. Return to `/data-tools`, review counts, financial totals, and relationship
   warnings. Download a final JSON backup.

## If a staged test fails

1. Stop entering new test data.
2. Download a JSON backup from `/data-tools/export.json` if the app is still
   available.
3. Record the route, user role, test data used, and any displayed message.
4. Fix and redeploy the application, then repeat the affected workflow from a
   known test record.

The JSON backup is a review/export snapshot, not a one-click restore tool. Do
not clear or overwrite D1 from the browser.

## Production cutover boundary

Production data requires a separate rehearsal. First generate `import.sql` and
`import-manifest.json` with `tools/export_django_sqlite_to_d1.py`, then import
only into a fresh or explicitly prepared D1 database using Wrangler. Compare
the manifest's row counts and financial control totals with `/data-tools` before
approving production access. Keep Cloudflare user accounts managed through User
Management; do not import Django password hashes.
