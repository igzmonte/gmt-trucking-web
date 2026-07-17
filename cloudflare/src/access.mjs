export const ROLE_PAGE_ACCESS = {
  admin: new Set(["Dashboard", "Trips", "Recurring Trips", "Employees", "Fleet / Equipment", "Clients", "Suppliers", "Repairs", "Vale / Cash Advance", "Payroll", "Billing", "Collections", "Payables", "Reports", "Settings", "User Management", "Data Tools"]),
  encoder: new Set(["Dashboard", "Trips", "Recurring Trips", "Employees", "Fleet / Equipment", "Clients", "Suppliers", "Repairs", "Vale / Cash Advance"]),
  viewer: new Set(["Dashboard", "Trips", "Recurring Trips", "Employees", "Fleet / Equipment", "Clients", "Suppliers", "Repairs", "Vale / Cash Advance", "Payroll", "Billing", "Collections", "Payables", "Reports"]),
  accounting: new Set(["Dashboard", "Payroll", "Billing", "Collections", "Payables", "Reports"]),
};

export const ROLE_EDIT_ACCESS = {
  admin: "*",
  encoder: new Set(["Trips", "Recurring Trips", "Employees", "Fleet / Equipment", "Clients", "Suppliers", "Repairs", "Vale / Cash Advance"]),
  viewer: new Set(),
  accounting: new Set(["Payroll", "Billing", "Collections", "Payables"]),
};

export function canView(user, page) {
  return Boolean(user?.active) && ROLE_PAGE_ACCESS[user.role]?.has(page);
}

export function canEdit(user, page) {
  if (!user?.active) return false;
  const allowed = ROLE_EDIT_ACCESS[user.role];
  return allowed === "*" || Boolean(allowed?.has(page));
}

export function requireView(user, page) {
  if (!user) return { redirect: "/login" };
  if (!canView(user, page)) return { status: 403, message: "You do not have permission to view this page." };
  return null;
}

export function requireEdit(user, page) {
  const viewError = requireView(user, page);
  if (viewError) return viewError;
  if (!canEdit(user, page)) return { status: 403, message: "You do not have permission to edit this page." };
  return null;
}
