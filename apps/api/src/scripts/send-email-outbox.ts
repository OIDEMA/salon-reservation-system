import { prisma } from "../database.js";
import { processEmailOutbox } from "../email-outbox.js";

try {
  const summary = await processEmailOutbox(prisma);
  const failedOutstanding = await prisma.emailOutbox.count({ where: { status: "FAILED" } });
  console.info("Email outbox run", { ...summary, failedOutstanding });
  if (failedOutstanding > 0) process.exitCode = 1;
} catch (error) {
  console.error("Email outbox run failed", error instanceof Error ? error.name : "UnknownError");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
