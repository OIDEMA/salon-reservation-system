import type { FastifyReply, FastifyRequest } from "fastify";
import { requireTenantContext, type TenantContext } from "./tenant-context.js";

export const PERMISSIONS = [
  "reservation.read", "reservation.write", "customer.read", "customer.write",
  "master.read", "master.write", "settings.read", "settings.write",
  "checkout.read", "checkout.write", "checkout.refund", "register.read", "register.close",
  "chart.read", "chart.write", "access.manage", "audit.read"
] as const;
export type Permission = typeof PERMISSIONS[number];
export type PermissionMembership = {
  role: string; status?: string; useCustomPermissions?: boolean; permissions?: readonly string[]; salonIds?: readonly string[];
};

const readPermissions = PERMISSIONS.filter((permission) => permission.endsWith(".read") && permission !== "audit.read");
const rolePermissions: Record<string, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  ADMIN: PERMISSIONS,
  MANAGER: PERMISSIONS.filter((permission) => permission !== "access.manage"),
  STAFF: [...readPermissions, "reservation.write", "customer.write", "checkout.write", "chart.write"],
  VIEWER: readPermissions
};

export function effectivePermissions(membership: PermissionMembership): Permission[] {
  if (membership.status && membership.status !== "ACTIVE") return [];
  if (membership.role === "OWNER") return [...PERMISSIONS];
  const permissions = membership.useCustomPermissions ? membership.permissions ?? [] : rolePermissions[membership.role] ?? [];
  const granted = PERMISSIONS.filter((permission) => permissions.includes(permission) &&
    (permission !== "access.manage" || membership.role === "ADMIN") &&
    (membership.role !== "VIEWER" || permission.endsWith(".read")));
  const requiredReads = granted.map((permission) => permission.endsWith(".write") ? permission.replace(/\.write$/, ".read") :
    permission === "checkout.refund" ? "checkout.read" : permission === "register.close" ? "register.read" : permission);
  return PERMISSIONS.filter((permission) => granted.includes(permission) || requiredReads.includes(permission));
}

export function hasPermission(context: TenantContext | PermissionMembership, permission: Permission | string): boolean {
  const membership = "membership" in context ? context.membership : context;
  return effectivePermissions(membership).includes(permission as Permission);
}

export function allowedSalonIds(membership: PermissionMembership): readonly string[] {
  return membership.role === "OWNER" ? [] : membership.salonIds ?? [];
}

export async function requirePermission(request: FastifyRequest, reply: FastifyReply, permission: Permission): Promise<TenantContext | null> {
  const context = await requireTenantContext(request, reply);
  if (!context) return null;
  if (!hasPermission(context, permission)) {
    reply.code(403).send({ code: "PERMISSION_DENIED", message: "この操作を行う権限がありません。" });
    return null;
  }
  return context;
}

export class AccessPolicyError extends Error {
  constructor(public code: string, message: string, public statusCode = 403) { super(message); }
}

export function assertAccessAssignment(actor: PermissionMembership & { userId: string }, targetUserId: string | undefined,
  current: PermissionMembership | undefined, next: PermissionMembership, tenantSalonIds: readonly string[]) {
  if (!hasPermission(actor, "access.manage") || !["OWNER", "ADMIN"].includes(actor.role)) {
    throw new AccessPolicyError("ACCESS_MANAGEMENT_DENIED", "権限を管理できません。");
  }
  if (targetUserId === actor.userId) {
    throw new AccessPolicyError("SELF_ACCESS_CHANGE_DENIED", "自分の権限・利用状態は変更できません。他のオーナーに依頼してください。");
  }
  if (next.salonIds?.some((id) => !tenantSalonIds.includes(id))) {
    throw new AccessPolicyError("INVALID_SALON_SCOPE", "同じテナントの店舗を指定してください。", 400);
  }
  if (actor.role === "OWNER") return;
  if (current?.role === "OWNER" || next.role === "OWNER") {
    throw new AccessPolicyError("OWNER_ACCESS_CHANGE_DENIED", "オーナーの権限はオーナーだけが管理できます。");
  }
  const ownPermissions = effectivePermissions(actor);
  const proposed = effectivePermissions({ ...next, status: "ACTIVE" });
  if (current && effectivePermissions({ ...current, status: "ACTIVE" }).some((permission) => !ownPermissions.includes(permission))) {
    throw new AccessPolicyError("TARGET_PERMISSION_OUT_OF_SCOPE", "自分の操作権限を超えるメンバーは管理できません。");
  }
  if (proposed.some((permission) => !ownPermissions.includes(permission))) {
    throw new AccessPolicyError("PERMISSION_ESCALATION_DENIED", "自分にない操作権限は付与できません。");
  }
  const scope = allowedSalonIds(actor);
  if (scope.length && current && (!current.salonIds?.length || current.salonIds.some((id) => !scope.includes(id)))) {
    throw new AccessPolicyError("TARGET_SALON_OUT_OF_SCOPE", "自分の店舗範囲外のメンバーは管理できません。");
  }
  if (scope.length && (!next.salonIds?.length || next.salonIds.some((id) => !scope.includes(id)))) {
    throw new AccessPolicyError("SALON_ESCALATION_DENIED", "自分が利用できる店舗の範囲で付与してください。");
  }
}

export function canManageMember(actor: PermissionMembership & {userId:string}, target: PermissionMembership & {userId?:string}): boolean {
  if(target.userId === actor.userId) return true;
  try { assertAccessAssignment(actor, target.userId, target, target, [...(actor.salonIds ?? []), ...(target.salonIds ?? [])]); return true; }
  catch { return false; }
}
