import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // the Studio page is read from disk at request time; make sure it ships with the function
  outputFileTracingIncludes: {
    "/": ["./studio/studio.html"],
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
