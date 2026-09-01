"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { useTenantSlug } from "./tenant-provider";
import { tenantPath } from "@/lib/tenant-routing";

type TenantLinkProps = Omit<ComponentProps<typeof Link>, "href"> & { href: string };

export function TenantLink({ href, ...props }: TenantLinkProps) {
  const tenantSlug = useTenantSlug();
  return <Link href={tenantPath(tenantSlug, href)} {...props} />;
}
