export type MasterResource = "staff" | "menus" | "categories" | "equipment";
export type MasterSummary = { id: string } & Record<string, unknown>;
export type MasterPage = {
  items: MasterSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};
