import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";
import { MembershipProvisionError, parseMembershipProvisionCommand, provisionMembership } from "../membership-provision.js";

export async function main(args = process.argv.slice(2), env = process.env) {
  let database: PrismaClient | undefined;
  try {
    const command = parseMembershipProvisionCommand(args, env);
    if (!env.DATABASE_URL) throw new MembershipProvisionError("INVALID_PROVISION_TARGET", "管理用のDB接続設定が必要です。");
    database = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    const result = await provisionMembership(database, command.input, { apply: command.apply, confirmationHash: command.confirmationHash });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    // Never print Prisma diagnostics, environment values, owner UID, or input validation details.
    const safe = error instanceof MembershipProvisionError ? error : new MembershipProvisionError("PROVISION_FAILED", "管理操作を完了できませんでした。");
    console.error(JSON.stringify({ code: safe.code, message: safe.message }));
    process.exitCode = 1;
  } finally {
    if (database) await database.$disconnect().catch(() => undefined);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
