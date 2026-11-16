/**
 * Who may sign in: the usernames in ACS_ALLOWED_GITHUB, the admin(s) in ACS_ADMIN_GITHUB (default pclk), and the
 * people the admin adds in the app (table acs_allowed). Kept apart from auth.ts so it has no Next.js dependency.
 */
import { listAllowed } from "./store";
import { appAdmins } from "./users";

const split = (v: string | undefined) => (v || "").split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

/** usernames from the environment (can't be removed from the app) */
export const envLogins = (): string[] => split(process.env.ACS_ALLOWED_GITHUB);
/** who manages the list in the app: ACS_ADMIN_GITHUB, default pclk */
export const adminLogins = (): string[] => split(process.env.ACS_ADMIN_GITHUB ?? "pclk");

let cache: { at: number; list: string[] } | null = null;
/** env list + people added in the app (cached for 20 s per server instance) */
export async function allowedLogins(fresh = false): Promise<string[]> {
  if (fresh || !cache || Date.now() - cache.at > 20_000) {
    let added: string[] = [];
    try {
      added = (await listAllowed()).map((r) => r.login);
      added.push(...(await appAdmins()));   // people given the admin role in the app can always sign in
    } catch (e) {
      console.error("allow-list lookup failed", e);
    }
    cache = { at: Date.now(), list: [...new Set([...envLogins(), ...adminLogins(), ...added])] };
  }
  return cache.list;
}
export const forgetAllowedCache = () => { cache = null; };
