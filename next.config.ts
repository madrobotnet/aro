import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Lets several dev servers run side by side from one checkout (NEXT_DIST_DIR=.next-lane).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  serverExternalPackages: ["argon2", "pg", "node-html-parser"],
  experimental: {
    // Attachment uploads up to 25 MB pass through the proxy.
    proxyClientMaxBodySize: "26mb",
  },
};

export default nextConfig;
