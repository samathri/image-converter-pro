import { one, toIso } from "./db.js";
import { isPro } from "./auth.js";

export const PLAN_MONTHS = [1, 3, 6, 12];

function addMonths(date, months) {
  const result = new Date(date);

  result.setMonth(result.getMonth() + months);
  return result;
}

/**
 * Adds months of Pro, starting from the current expiry if still active.
 * Pass q from transaction() to run inside a transaction.
 */
export async function extendPro(userId, months, q) {
  const run = q || (async (sql, params) => [await one(sql, params)]);
  const [user] = await run("SELECT pro_until FROM users WHERE id = $1 FOR UPDATE", [userId]);
  const start = isPro(user) ? new Date(user.pro_until) : new Date();
  const until = addMonths(start, months);

  await run("UPDATE users SET pro_until = $1 WHERE id = $2", [until, userId]);
  return toIso(until);
}
