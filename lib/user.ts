/**
 * Who is calling. Data is keyed by the GitHub account id (stable even if the username changes).
 *
 * ACS_INSECURE_DEV_USER lets local development and the automated tests run without GitHub. It is ignored whenever
 * the app runs on Vercel, so it can never open up a deployment.
 */
import { auth } from "@/auth";
import { allowedLogins, adminLogins } from "./allow";

export type User = { owner: string; login: string; name?: string | null; image?: string | null; admin?: boolean };

export function devUser(): User | null {
  const dev = process.env.ACS_INSECURE_DEV_USER;
  if (!dev || process.env.VERCEL) return null;
  return { owner: `dev:${dev}`, login: dev, name: dev, admin: adminLogins().includes(dev.toLowerCase()) };
}

export async function currentUser(): Promise<User | null> {
  const dev = devUser();
  if (dev) return dev;
  const s = await auth();
  const u = s?.user as { login?: string; ghid?: string; name?: string | null; image?: string | null } | undefined;
  if (!u?.login || !u.ghid) return null;
  // the allow-list is checked again on every request, so removing someone takes effect immediately
  const login = u.login.toLowerCase();
  if (!(await allowedLogins()).includes(login)) return null;
  return { owner: `gh:${u.ghid}`, login: u.login, name: u.name, image: u.image, admin: adminLogins().includes(login) };
}
