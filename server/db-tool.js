// Look inside the database from the command line.
//   npm run db                         overview: tables and users
//   npm run db -- sql "SELECT ..."     run any SQL query
//   npm run db -- unlock-logins        clear the login attempt limits
// Uses DATABASE_URL if set (e.g. Vercel's Neon database after
// `vercel env pull .env.local`), otherwise the local data/pglite database.
import "./env.js";
import { query, usingLocalDatabase } from "./db.js";

const [command = "overview", ...rest] = process.argv.slice(2);

// The local database (PGlite) can only be opened by one program at a time.
if (usingLocalDatabase) {
  const port = process.env.PORT || 3001;
  const running = await fetch(`http://localhost:${port}/api/me`, { signal: AbortSignal.timeout(1500) })
    .then(() => true)
    .catch(() => false);

  if (running) {
    console.error(`The app is running on port ${port}. Stop it first (Ctrl+C), then run this again.`);
    process.exit(1);
  }
}

console.log(usingLocalDatabase ? "Database: local (data/pglite)\n" : "Database: DATABASE_URL\n");

const show = (rows) => (rows.length ? console.table(rows) : console.log("(no rows)"));

switch (command) {
  case "overview": {
    const tables = ["users", "payments", "sessions", "visitors", "ip_usage", "settings", "rate_limits"];
    const counts = {};

    for (const t of tables) counts[t] = (await query(`SELECT COUNT(*)::int n FROM ${t}`))[0].n;

    console.log("Rows per table:");
    console.table(counts);

    console.log("\nUsers:");
    show(
      await query(
        `SELECT id, email, name, role, free_uses,
                to_char(pro_until, 'YYYY-MM-DD') AS pro_until,
                to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created
         FROM users ORDER BY id`
      )
    );

    console.log("\nSettings:");
    show(await query("SELECT key, value FROM settings ORDER BY key"));
    break;
  }

  case "sql": {
    const sql = rest.join(" ");

    if (!sql) {
      console.error('Usage: npm run db -- sql "SELECT * FROM users"');
      process.exit(1);
    }

    show(await query(sql));
    break;
  }

  case "unlock-logins": {
    await query("DELETE FROM rate_limits");
    console.log("Login attempt limits cleared. You can try signing in again.");
    break;
  }

  default:
    console.error(`Unknown command "${command}". Use: overview, sql, unlock-logins`);
    process.exit(1);
}

process.exit(0);
