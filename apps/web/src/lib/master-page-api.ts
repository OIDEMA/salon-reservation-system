import { backendJson } from "./backend";
import type { MasterPage, MasterResource } from "./master-page-types";

/** List pages load a bounded summary response, independently of booking catalogs. */
export function fetchMasterPage(resource: MasterResource) {
  return backendJson<MasterPage>(`/api/admin/${resource}/page`);
}
