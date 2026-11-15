/**
 * Sign-in with GitHub (Auth.js). Only allowed usernames can sign in (see lib/allow.ts: the admin, ACS_ALLOWED_GITHUB,
 * and people the admin adds in the app). Sessions are signed JWT cookies, so no session table is needed.
 *
 * Env: AUTH_SECRET, AUTH_GITHUB_ID, AUTH_GITHUB_SECRET, optional ACS_ALLOWED_GITHUB, ACS_ADMIN_GITHUB (default pclk).
 */
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { allowedLogins } from "@/lib/allow";

export { allowedLogins, envLogins, adminLogins } from "@/lib/allow";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  trustHost: true,
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 90 },
  callbacks: {
    async signIn({ profile }) {
      const login = String((profile as { login?: string } | undefined)?.login || "").toLowerCase();
      return !!login && (await allowedLogins(true)).includes(login);
    },
    jwt({ token, profile }) {
      if (profile) {
        token.login = (profile as { login?: string }).login;
        token.ghid = String((profile as { id?: string | number }).id ?? "");
      }
      return token;
    },
    session({ session, token }) {
      const u = session.user as typeof session.user & { login?: string; ghid?: string };
      u.login = token.login as string | undefined;
      u.ghid = token.ghid as string | undefined;
      return session;
    },
  },
});
