import { spawnSync } from "node:child_process";

// Native App Hosting Git builds may first install the repository workspaces.
// Give the app its own dependencies so its standalone bundle stays at apps/web.
if (process.env.APP_HOSTING_BUILD === "1") {
  const result = spawnSync("npm", ["ci", "--workspaces=false"], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
