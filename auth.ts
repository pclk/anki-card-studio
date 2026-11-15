/**
 * Sign-in with GitHub (Auth.js). Only the GitHub usernames listed in ACS_ALLOWED_GITHUB can sign in; with the list
 * empty, nobody can. Sessions are signed JWT cookies, so no session table is needed.
 *
 * Env: AUTH_SECRET, AUTH_GITHUB_ID, AUTH_GITHUB_SECRET, ACS_ALLOWED_GITHUB (e.g. "pclk" or "pclk, friend").
 */
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

export function allowedLogins(): string[] {
  return (process.env.ACS_ALLOWED_GITHUB || "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  trustHost: true,
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 90 },
  callbacks: {
    signIn({ profile }) {
      const login = String((profile as { login?: string } | undefined)?.login || "").toLowerCase();
      return !!login && allowedLogins().includes(login);
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
