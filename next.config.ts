import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // the Studio page and the skill (served at /skill/...) are read from disk at request time; make sure they ship
  outputFileTracingIncludes: {
    "/": ["./studio/studio.html"],
    "/skill/[file]": ["./skill/anki/SKILL.md", "./skill/anki/scripts/*.py"],
  },
  poweredByHeader: false,
  // only loaded for local development without a database URL (ACS_PGLITE_DIR)
  serverExternalPackages: ["@electric-sql/pglite"],
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
        ],
      },
    ];
  },
};

export default nextConfig;
