/**
 * The user registry and the admin's controls.
 *
 * Everyone who signs in gets a row in acs_users (their data is stored under `owner`, the GitHub account id, so this
 * is also how the admin finds a username's data). The row carries the admin's controls for that account:
 *   role        'user' | 'admin'     (the ACS_ADMIN_GITHUB admins are always admin)
 *   status      'active' | 'readonly' | 'disabled'
 *   quota_mb    storage limit in MB (null = no limit)
 *   signed_out  sessions that started before this time are refused ("sign out everywhere")
 */
import { db, ensureSchema, transaction } from "./db";
import { HttpError, ID_RE } from "./store";
import type { User } from "./user";

export type UserRow = {
  owner: string; login: string; name: string | null; image: string | null;
  role: "user" | "admin"; status: "active" | "readonly" | "disabled"; quota_mb: number | null;
  signed_out: string | null; first_seen: string; last_seen: string;
};

const ROLES = new Set(["user", "admin"]);
const STATUSES = new Set(["active", "readonly", "disabled"]);

/* ------------------------------------------------------------------ registry (cached briefly per server instance) */
const rowCache = new Map<string, { at: number; row: UserRow | null }>();
const seenAt = new Map<string, number>();

export function forgetUser(owner?: string) {
  if (owner) rowCache.delete(owner); else rowCache.clear();
}

export async function getUserRow(owner: string, fresh = false): Promise<UserRow | null> {
  const c = rowCache.get(owner);
  if (!fresh && c && Date.now() - c.at < 15_000) return c.row;
  await ensureSchema();
  const r = await db()<UserRow>("select * from acs_users where owner = $1", [owner]);
  const row = r[0] ?? null;
  rowCache.set(owner, { at: Date.now(), row });
  return row;
}

/** record that someone is using the app (at most every 5 minutes per account) */
export async function touchUser(owner: string, login: string, name?: string | null, image?: string | null): Promise<void> {
  const last = seenAt.get(owner) || 0;
  if (Date.now() - last < 5 * 60_000 && rowCache.get(owner)?.row) return;
  seenAt.set(owner, Date.now());
  await ensureSchema();
  await db()(
    `insert into acs_users (owner, login, name, image) values ($1, lower($2), $3, $4)
     on conflict (owner) do update set login = lower(excluded.login), name = coalesce(excluded.name, acs_users.name),
       image = coalesce(excluded.image, acs_users.image), last_seen = now()`,
    [owner, login, name ?? null, image ?? null],
  );
  rowCache.delete(owner);
}

/** logins given the admin role in the app */
export async function appAdmins(): Promise<string[]> {
  await ensureSchema();
  return (await db()<{ login: string }>("select login from acs_users where role = 'admin'")).map((r) => r.login);
}

/* ------------------------------------------------------------------ storage use and limits */
export async function usage(owner: string): Promise<{ projects: number; projectBytes: number; files: number; fileBytes: number; total: number }> {
  await ensureSchema();
  const [p] = await db()<{ n: string; b: string }>("select count(*) as n, coalesce(sum(octet_length(data)), 0) as b from acs_projects where owner = $1", [owner]);
  const [f] = await db()<{ n: string; b: string }>("select count(*) as n, coalesce(sum(size), 0) as b from acs_files where owner = $1", [owner]);
  const projectBytes = Number(p.b), fileBytes = Number(f.b);
  const [extra] = await db()<{ bytes: string }>(`select coalesce(sum(n),0) as bytes from (
    select octet_length(data) as n from acs_settings where owner=$1
    union all select octet_length(entry) from acs_index where owner=$1
    union all select coalesce(byte_size, octet_length(data)) from acs_upload_chunks where owner=$1
  ) usage`, [owner]);
  return { projects: Number(p.n), projectBytes, files: Number(f.n), fileBytes, total: projectBytes + fileBytes + Number(extra.bytes) };
}

/** Called inside the account write transaction, after mutation. */
export async function checkQuota(owner: string, adding: number): Promise<void> {
  const row = await getUserRow(owner, true);
  if (!row || row.quota_mb == null) return;
  if ((await usage(owner)).total + adding > row.quota_mb * 1024 * 1024)
    throw new HttpError(413, `storage limit reached (${row.quota_mb} MB) - ask the admin for more space or delete old projects`);
}

/* ------------------------------------------------------------------ admin: list and change accounts */
export async function listUsers(allowed: string[], envAdmins: string[]) {
  await ensureSchema();
  const rows = await db()<UserRow & { projects: string; pbytes: string; files: string; fbytes: string; updated: string | null }>(
    `select u.*,
       (select count(*) from acs_projects p where p.owner = u.owner) as projects,
       (select coalesce(sum(octet_length(data)), 0) from acs_projects p where p.owner = u.owner) as pbytes,
       (select count(*) from acs_files f where f.owner = u.owner) as files,
       (select coalesce(sum(size), 0) from acs_files f where f.owner = u.owner) as fbytes,
       (select max(updated) from acs_projects p where p.owner = u.owner) as updated
     from acs_users u order by u.last_seen desc`);
  const seen = new Set(rows.map((r) => r.login));
  const users = rows.map((r) => ({
    owner: r.owner, login: r.login, name: r.name, image: r.image,
    role: envAdmins.includes(r.login) ? "admin" : r.role, envAdmin: envAdmins.includes(r.login),
    status: r.status, quota_mb: r.quota_mb == null ? null : Number(r.quota_mb), signed_out: r.signed_out,
    first_seen: r.first_seen, last_seen: r.last_seen, allowed: allowed.includes(r.login) || r.owner.startsWith("dev:"),
    projects: Number(r.projects), bytes: Number(r.pbytes) + Number(r.fbytes), files: Number(r.files), updated: r.updated,
  }));
  for (const user of users) user.bytes = (await usage(user.owner)).total;
  // allowed but never signed in yet
  const pending = allowed.filter((l) => !seen.has(l)).map((login) => ({ login, envAdmin: envAdmins.includes(login) }));
  return { users, pending };
}

export async function updateUser(owner: string, patch: { role?: string; status?: string; quota_mb?: number | null; signOut?: boolean },
                                 envAdmins: string[], me: string): Promise<UserRow> {
  const row = await getUserRow(owner, true);
  if (!row) throw new HttpError(404, "no such user");
  const protectedAdmin = envAdmins.includes(row.login);
  const sets: string[] = [], args: unknown[] = [owner];
  if (patch.role !== undefined) {
    if (!ROLES.has(patch.role)) throw new HttpError(400, "role must be user or admin");
    if (protectedAdmin && patch.role !== "admin") throw new HttpError(400, "this admin is set in ACS_ADMIN_GITHUB - change it there");
    if (row.owner === me && patch.role !== "admin") throw new HttpError(400, "you can't remove your own admin role");
    args.push(patch.role); sets.push(`role = $${args.length}`);
  }
  if (patch.status !== undefined) {
    if (!STATUSES.has(patch.status)) throw new HttpError(400, "status must be active, readonly or disabled");
    if ((protectedAdmin || row.owner === me) && patch.status !== "active") throw new HttpError(400, "an admin account can't be restricted");
    args.push(patch.status); sets.push(`status = $${args.length}`);
  }
  if (patch.quota_mb !== undefined) {
    const q = patch.quota_mb == null || (patch.quota_mb as unknown) === "" ? null : Math.round(Number(patch.quota_mb));
    if (q != null && (!Number.isFinite(q) || q < 1 || q > 100_000)) throw new HttpError(400, "storage limit must be 1-100000 MB, or empty for none");
    args.push(q); sets.push(`quota_mb = $${args.length}`);
  }
  if (patch.signOut) {
    if (row.owner === me) throw new HttpError(400, "use Sign out to end your own session");
    sets.push("signed_out = now()");
  }
  if (sets.length) await db()(`update acs_users set ${sets.join(", ")} where owner = $1`, args);
  forgetUser(owner);
  return (await getUserRow(owner, true))!;
}

/** remove everything an account has stored (and, with forget, the account's row) */
async function wipeUserInner(owner: string, forget: boolean): Promise<void> {
  await ensureSchema();
  for (const t of ["acs_upload_chunks", "acs_upload_files", "acs_chunks", "acs_files", "acs_history", "acs_projects", "acs_index", "acs_deleted", "acs_settings"])
    await db()(`delete from ${t} where owner = $1`, [owner]);
  // the Mac bridge: its jobs (their files went above) and every device token
  await db()("delete from acs_job_events where job in (select id from acs_jobs where owner = $1)", [owner]);
  for (const t of ["acs_jobs", "acs_devices"]) await db()(`delete from ${t} where owner = $1`, [owner]);
  if (forget) await db()("delete from acs_users where owner = $1", [owner]);
  forgetUser(owner);
}

/* ------------------------------------------------------------------ admin: one account's data */
export async function userProjects(owner: string) {
  await ensureSchema();
  const idx = await db()<{ id: string; entry: string }>("select id, entry from acs_index where owner = $1", [owner]);
  const del = new Set((await db()<{ id: string }>("select id from acs_deleted where owner = $1", [owner])).map((r) => r.id));
  const proj = await db()<{ id: string; rev: number; updated: string; bytes: string; head: string }>(
    "select id, rev, updated, octet_length(data) as bytes, left(data, 400) as head from acs_projects where owner = $1", [owner]);
  const files = await db()<{ project: string; n: string; b: string }>(
    "select project, count(*) as n, coalesce(sum(size), 0) as b from acs_files where owner = $1 group by project", [owner]);
  const hist = await db()<{ id: string; n: string }>("select id, count(*) as n from acs_history where owner = $1 group by id", [owner]);
  const ids = new Set([...idx.map((r) => r.id), ...proj.map((r) => r.id), ...del, ...hist.map((r) => r.id)]);
  const entry = new Map(idx.map((r) => { try { return [r.id, JSON.parse(r.entry)]; } catch { return [r.id, {}]; } }));
  return [...ids].map((id) => {
    const p = proj.find((r) => r.id === id), e = entry.get(id) || {}, f = files.find((r) => r.project === id);
    return {
      id, name: (e as { name?: string }).name || null, cards: (e as { cards?: number }).cards ?? null,
      rev: p ? Number(p.rev) : null, updated: p?.updated ?? null, bytes: p ? Number(p.bytes) : 0,
      files: f ? Number(f.n) : 0, fileBytes: f ? Number(f.b) : 0, deleted: del.has(id), stored: !!p,
      history: Number(hist.find((r) => r.id === id)?.n || 0),
    };
  }).sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, { numeric: true }));
}

/** rename: the project's own name and its entry in the list */
export async function renameProject(owner: string, id: string, name: string): Promise<void> {
  if (!ID_RE.test(id)) throw new HttpError(400, "bad project id");
  name = String(name || "").trim().slice(0, 200);
  if (!name) throw new HttpError(400, "name required");
  await ensureSchema();
  const r = await db()<{ data: string; rev: number }>("select data, rev from acs_projects where owner = $1 and id = $2", [owner, id]);
  if (r.length) {
    const j = JSON.parse(r[0].data); j.projectName = name; j.rev = (Number(j.rev) || 0) + 1; j.savedAt = Date.now(); j.savedBy = "admin";
    await db()("update acs_projects set data = $3, rev = $4, updated = now() where owner = $1 and id = $2", [owner, id, JSON.stringify(j), j.rev]);
  }
  const e = await db()<{ entry: string }>("select entry from acs_index where owner = $1 and id = $2", [owner, id]);
  if (e.length) {
    const j = JSON.parse(e[0].entry); j.name = name; j.updated = Date.now();
    await db()("update acs_index set entry = $3, updated = $4 where owner = $1 and id = $2", [owner, id, JSON.stringify(j), j.updated]);
  }
}

/** bring back a deleted project: from its latest history copy when it is gone from storage */
export async function restoreProject(owner: string, id: string): Promise<void> {
  await ensureSchema();
  await db()("delete from acs_deleted where owner = $1 and id = $2", [owner, id]);
  const have = await db()("select 1 from acs_projects where owner = $1 and id = $2", [owner, id]);
  if (!have.length) {
    const h = await db()<{ data: string; rev: number }>("select data, rev from acs_history where owner = $1 and id = $2 order by at desc limit 1", [owner, id]);
    if (!h.length) throw new HttpError(404, "nothing left to restore");
    await db()("insert into acs_projects (owner, id, data, rev) values ($1, $2, $3, $4)", [owner, id, h[0].data, h[0].rev]);
  }
  const d = (await db()<{ data: string }>("select data from acs_projects where owner = $1 and id = $2", [owner, id]))[0].data;
  const j = JSON.parse(d);
  const entry = { id, name: j.projectName || j.deck || "Untitled", cards: (j.cards || []).length, updated: Date.now() };
  await db()(
    `insert into acs_index (owner, id, entry, updated) values ($1, $2, $3, $4)
     on conflict (owner, id) do update set entry = excluded.entry, updated = excluded.updated`,
    [owner, id, JSON.stringify(entry), entry.updated]);
}

export async function projectHistory(owner: string, id: string) {
  await ensureSchema();
  return (await db()<{ rev: number; at: string; bytes: string }>(
    "select rev, at, octet_length(data) as bytes from acs_history where owner = $1 and id = $2 order by at desc", [owner, id]))
    .map((r) => ({ rev: Number(r.rev), at: r.at, bytes: Number(r.bytes) }));
}

/** put a saved copy back as the current version (the current one goes into history first) */
export async function restoreRevision(owner: string, id: string, at: string): Promise<void> {
  await ensureSchema();
  const h = await db()<{ data: string }>("select data from acs_history where owner = $1 and id = $2 and at = $3", [owner, id, at]);
  if (!h.length) throw new HttpError(404, "no such saved copy");
  const cur = await db()<{ rev: number }>("select rev from acs_projects where owner = $1 and id = $2", [owner, id]);
  const j = JSON.parse(h[0].data); j.rev = (cur.length ? Number(cur[0].rev) : Number(j.rev) || 0) + 1; j.savedAt = Date.now(); j.savedBy = "admin";
  await db()("insert into acs_history (owner, id, rev, data) select owner, id, rev, data from acs_projects where owner = $1 and id = $2", [owner, id]);
  await db()(
    `insert into acs_projects (owner, id, data, rev) values ($1, $2, $3, $4)
     on conflict (owner, id) do update set data = excluded.data, rev = excluded.rev, updated = now()`,
    [owner, id, JSON.stringify(j), j.rev]);
  await restoreProject(owner, id);
}

export async function projectFiles(owner: string, id: string) {
  await ensureSchema();
  return (await db()<{ kind: string; name: string; mime: string; size: string; complete: boolean; updated: string }>(
    "select kind, name, mime, size, complete, updated from acs_files where owner = $1 and project = $2 order by kind, name", [owner, id]))
    .map((r) => ({ ...r, size: Number(r.size) }));
}

/** a signed-in caller as the admin's controls make them: role, status, and refused if signed out everywhere */
export async function applyRegistry(u: User, sessionStart: number | null, envAdmins: string[]): Promise<User | null> {
  try {
    await touchUser(u.owner, u.login, u.name, u.image);
    const row = await getUserRow(u.owner);
    if (!row) return null;
    if (row?.signed_out && sessionStart != null && sessionStart < new Date(row.signed_out).getTime()) return null;
    const envAdmin = envAdmins.includes(u.login.toLowerCase());
    return { ...u, admin: envAdmin || row?.role === "admin", status: envAdmin ? "active" : row?.status || "active" };
  } catch (e) {
    console.error("user registry unavailable", e);
    throw new HttpError(503, "account verification temporarily unavailable");
  }
}

/** Recovery copies have a separate bounded budget, so deletion frees active space. */
export async function trimHistory(owner: string, known?: UserRow | null): Promise<void> {
  const row = known === undefined ? await getUserRow(owner, true) : known;
  const budget = (row?.quota_mb ?? 64) * 1024 * 1024;
  await db()(`delete from acs_history where ctid in (
    select tid from (select ctid as tid,
      sum(octet_length(data)) over (order by at desc, ctid desc) as bytes,
      row_number() over (partition by id order by at desc, ctid desc) as n
      from acs_history where owner=$1) ranked where bytes > $2 or n > 30)`, [owner,budget]);
}

export async function wipeUser(owner: string, forget: boolean): Promise<void> { return transaction(owner, () => wipeUserInner(owner,forget)); }
