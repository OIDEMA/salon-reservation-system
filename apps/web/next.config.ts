import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

const monorepoRoot = path.resolve(__dirname, "../..");
const rootManifestPath = path.join(monorepoRoot, "package.json");
const rootManifest = existsSync(rootManifestPath)
  ? JSON.parse(readFileSync(rootManifestPath, "utf8")) as { workspaces?: string[] | { packages?: string[] } }
  : undefined;
const workspaces = Array.isArray(rootManifest?.workspaces) ? rootManifest.workspaces : rootManifest?.workspaces?.packages;
// App Hosting builds apps/web as one independent app, even from a full Git checkout.
const workspaceRoot = process.env.APP_HOSTING_BUILD === "1"
  ? __dirname
  : workspaces?.some((entry) => entry === "apps/*" || entry === "apps/web") ? monorepoRoot : __dirname;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  turbopack: { root: workspaceRoot }
};

export default nextConfig;
