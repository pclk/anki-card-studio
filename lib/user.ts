/**
 * Who is calling. Data is keyed by the GitHub account id (stable even if the username changes).
 *
 * Every request also checks the admin's controls for the account (lib/users.ts): disabled accounts are refused,
 * read-only ones can't write, "sign out everywhere" ends sessions that started earlier, and the admin role.
 *
 * ACS_INSECURE_DEV_USER lets local development and the automated tests run without GitHub. It is ignored whenever
 * the app runs on Vercel, so it can never open up a deployment.
 */
import { auth } from "@/auth";
import { allowedLogins, adminLogins } from "./allow";
import { applyRegistry } from "./users";

export type User = {
  owner: string; login: string; name?: string | null; image?: string | null; admin?: boolean;
  status?: "active" | "readonly" | "disabled";
  /** set when the caller is the Mac bridge signed in with a device token (lib/bridge.ts) */
  device?: string;
};

/** apply the registry (role, status, sign-out-everywhere) - see lib/users.ts */
const withRegistry = (u: User, sessionStart: number | null) => applyRegistry(u, sessionStart, adminLogins());

export function devUser(): User | null {
  const dev = process.env.ACS_INSECURE_DEV_USER;
  if (!dev || process.env.VERCEL) return null;
  return { owner: `dev:${dev}`, login: dev, name: dev, admin: adminLogins().includes(dev.toLowerCase()) };
}

export async function currentUser(): Promise<User | null> {
  const dev = devUser();
  if (dev) return withRegistry(dev, null);
  const s = await auth();
  const u = s?.user as { login?: string; ghid?: string; name?: string | null; image?: string | null; sat?: number } | undefined;
  if (!u?.login || !u.ghid) return null;
  // the allow-list is checked again on every request, so removing someone takes effect immediately
  const login = u.login.toLowerCase();
  if (!(await allowedLogins()).includes(login)) return null;
  return withRegistry({ owner: `gh:${u.ghid}`, login: u.login, name: u.name, image: u.image, admin: adminLogins().includes(login) }, u.sat || 0);
}
