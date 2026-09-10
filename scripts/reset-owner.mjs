#!/usr/bin/env node
/**
 * Correct the owner account, without touching a single lead.
 *
 * The owner is `APP_OWNER_EMAIL` when that is set, and otherwise the earliest
 * account in Better Auth's `"user"` table (see src/lib/auth/owner.ts). So the
 * owner "record" is one row in `"user"`, plus its `"session"` and `"account"`
 * rows, which carry `on delete cascade` and follow it automatically.
 *
 * Nothing else follows it. `leads`, `outreach_emails`, `outreach_settings`,
 * `outreach_templates`, `outreach_suppression` and `gmail_accounts` are keyed by
 * a `user_id` TEXT column with **no foreign key** to `"user"` — the schema
 * cannot cascade a delete into them, and neither can this script: it issues no
 * statement of any kind against those tables.
 *
 * Two ways to correct a wrong address:
 *
 *   --rename <old> <new>   Change the email on the existing row. The user id is
 *                          unchanged, so every lead and every outreach row stays
 *                          attached to the owner. The password is unchanged.
 *                          This is the one to prefer.
 *
 *   --remove <email>       Delete the auth rows for that address so the next
 *                          account created claims the app. App data is left
 *                          exactly as it is — but it stays attached to the OLD
 *                          user id, so a new owner starts with an empty
 *                          server-side sheet (the browser's local copy is
 *                          untouched and still works).
 *
 * Reads are free; every write needs --confirm. With no mode it just reports.
 *
 *   DATABASE_URL=… node scripts/reset-owner.mjs
 *   DATABASE_URL=… node scripts/reset-owner.mjs --rename a@x.com b@y.com --confirm
 */
import pg from "pg";

const argv = process.argv.slice(2);
const confirm = argv.includes("--confirm");
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv.slice(at + 1).filter((a) => !a.startsWith("--"));
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set. Run this with the app's connection string.");
  process.exit(1);
}

/** Tables this script may never write to, asserted rather than assumed. */
const NEVER_TOUCH = [
  "leads",
  "outreach_emails",
  "outreach_settings",
  "outreach_templates",
  "outreach_suppression",
  "gmail_accounts",
];

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });

async function countsOf(client) {
  const out = {};
  for (const table of NEVER_TOUCH) {
    const { rows } = await client.query(
      `select count(*)::int as n from information_schema.tables where table_name = $1`,
      [table],
    );
    if (rows[0].n === 0) {
      out[table] = "(table not present)";
      continue;
    }
    const { rows: c } = await client.query(`select count(*)::int as n from "${table}"`);
    out[table] = c[0].n;
  }
  return out;
}

async function listAccounts(client) {
  const { rows } = await client.query(
    `select "id", "email", "createdAt" from "user" order by "createdAt" asc, "id" asc`,
  );
  return rows;
}

/** How much app data is filed under a user id, so nothing is deleted blind. */
async function dataFor(client, userId) {
  const { rows } = await client.query(`select count(*)::int as n from leads where user_id = $1`, [
    userId,
  ]);
  const { rows: e } = await client.query(
    `select count(*)::int as n from outreach_emails where user_id = $1`,
    [userId],
  );
  return { leads: rows[0].n, outreachEmails: e[0].n };
}

async function main() {
  const client = await pool.connect();
  try {
    const before = await countsOf(client);
    const accounts = await listAccounts(client);

    console.log("Accounts in Better Auth, oldest first (the oldest owns the app");
    console.log("unless APP_OWNER_EMAIL is set):\n");
    for (const [index, row] of accounts.entries()) {
      const data = await dataFor(client, row.id);
      console.log(
        `  ${index === 0 ? "OWNER " : "      "}${row.email}` +
          `\n         id=${row.id}  created=${new Date(row.createdAt).toISOString()}` +
          `\n         leads filed under it: ${data.leads}   outreach emails: ${data.outreachEmails}`,
      );
    }
    if (accounts.length === 0) console.log("  (none — the next account created will own the app)");

    console.log("\nApp data present (this script never writes to any of these):");
    for (const [table, n] of Object.entries(before)) console.log(`  ${table}: ${n}`);

    const rename = flag("--rename");
    const remove = flag("--remove");

    if (!rename && !remove) {
      console.log("\nNothing to do. Pass --rename <old> <new> or --remove <email>, then --confirm.");
      return;
    }

    if (rename) {
      const [oldEmail, newEmail] = rename;
      if (!oldEmail || !newEmail) throw new Error("--rename needs <old-email> <new-email>");
      const target = accounts.find((r) => r.email.toLowerCase() === oldEmail.toLowerCase());
      if (!target) throw new Error(`No account with email ${oldEmail}`);
      if (accounts.some((r) => r.email.toLowerCase() === newEmail.toLowerCase())) {
        throw new Error(`An account with ${newEmail} already exists — remove it first, or sign in as it.`);
      }
      const data = await dataFor(client, target.id);
      console.log(
        `\nWILL UPDATE one row of "user":` +
          `\n  id     ${target.id}   (unchanged — so its ${data.leads} lead(s) and ` +
          `${data.outreachEmails} outreach email(s) stay attached)` +
          `\n  email  ${target.email}  ->  ${newEmail}` +
          `\n  password unchanged; sign in with the new address and the same password.`,
      );
      if (!confirm) {
        console.log("\nDry run. Re-run with --confirm to apply.");
        return;
      }
      await client.query("BEGIN");
      await client.query(`update "user" set "email" = $2, "updatedAt" = now() where "id" = $1`, [
        target.id,
        newEmail,
      ]);
      // Some Better Auth versions file the credential row under the address.
      await client.query(
        `update "account" set "accountId" = $2, "updatedAt" = now()
          where "userId" = $1 and lower("accountId") = lower($3)`,
        [target.id, newEmail, target.email],
      );
      await client.query("COMMIT");
      console.log("Done.");
    }

    if (remove) {
      const [email] = remove;
      if (!email) throw new Error("--remove needs <email>");
      const target = accounts.find((r) => r.email.toLowerCase() === email.toLowerCase());
      if (!target) throw new Error(`No account with email ${email}`);
      const data = await dataFor(client, target.id);
      console.log(
        `\nWILL DELETE the auth rows for ${target.email}:` +
          `\n  "user"     1 row (id ${target.id})` +
          `\n  "session"  its rows, via on delete cascade` +
          `\n  "account"  its rows, via on delete cascade  (this is the password)` +
          `\n\nWILL NOT DELETE, and does not reference:` +
          `\n  ${NEVER_TOUCH.join(", ")}`,
      );
      if (data.leads > 0 || data.outreachEmails > 0) {
        console.log(
          `\n  NOTE: ${data.leads} lead(s) and ${data.outreachEmails} outreach email(s) are filed` +
            `\n  under this user id. They are NOT deleted, but a new owner gets a new id and` +
            `\n  will not see them server-side. Prefer --rename to keep them attached.`,
        );
      }
      if (!confirm) {
        console.log("\nDry run. Re-run with --confirm to apply.");
        return;
      }
      await client.query("BEGIN");
      const { rowCount } = await client.query(`delete from "user" where "id" = $1`, [target.id]);
      await client.query("COMMIT");
      console.log(`Done — ${rowCount} user row deleted.`);
    }

    // Prove the promise rather than asserting it.
    const after = await countsOf(client);
    const changed = Object.keys(before).filter((t) => before[t] !== after[t]);
    if (changed.length > 0) {
      console.error(`\nAPP DATA CHANGED, which must never happen: ${changed.join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log("\nVerified: every app-data table has exactly the same row count as before.");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
