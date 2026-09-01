import { spawn } from "node:child_process";

const maximumAttempts = 8;
const retryDelayMs = 15_000;

function runPrismaPush() {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("npx", ["--no-install", "prisma", "db", "push", "--accept-data-loss"], {
      stdio: "inherit",
      env: process.env
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
  const exitCode = await runPrismaPush();
  if (exitCode === 0) process.exit(0);
  if (attempt === maximumAttempts) process.exit(exitCode);

  console.error(`Schema deployment attempt ${attempt}/${maximumAttempts} failed; retrying in ${retryDelayMs / 1000}s.`);
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
}
