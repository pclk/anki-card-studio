/**
 * Create the tables (the app also does this on first use, so running this is optional).
 *   DATABASE_URL=... npm run db:migrate
 */
import { ensureSchema, db } from "../lib/db";

async function main() {
  await ensureSchema();
  const t = await db()<{ table_name: string }>(
    "select table_name from information_schema.tables where table_name like 'acs_%' order by table_name",
  );
  console.log("tables:", t.map((x) => x.table_name).join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
