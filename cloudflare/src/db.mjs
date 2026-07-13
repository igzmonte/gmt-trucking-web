export async function all(env, sql, params = []) {
  const result = await env.DB.prepare(sql).bind(...params).all();
  return result.results || [];
}

export async function first(env, sql, params = []) {
  return await env.DB.prepare(sql).bind(...params).first();
}

export async function run(env, sql, params = []) {
  return await env.DB.prepare(sql).bind(...params).run();
}

export async function count(env, table) {
  const row = await first(env, `SELECT COUNT(*) AS total FROM ${table}`);
  return Number(row?.total || 0);
}

export async function dashboard(env) {
  const [trips, ongoing, completed, employees, billings, collections] = await Promise.all([
    count(env, "trips"),
    first(env, "SELECT COUNT(*) AS total FROM trips WHERE status='Ongoing'"),
    first(env, "SELECT COUNT(*) AS total FROM trips WHERE status='Completed'"),
    first(env, "SELECT COUNT(*) AS total FROM employees WHERE active=1"),
    first(env, "SELECT COALESCE(SUM(grand_total),0) AS total FROM billing_statements"),
    first(env, "SELECT COALESCE(SUM(amount_paid),0) AS total FROM collections"),
  ]);
  return {
    trips,
    ongoing: Number(ongoing?.total || 0),
    completed: Number(completed?.total || 0),
    employees: Number(employees?.total || 0),
    receivables: Number(billings?.total || 0) - Number(collections?.total || 0),
  };
}
