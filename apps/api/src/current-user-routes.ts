import type { FastifyInstance } from "fastify";
import { requireAuthenticatedUser } from "./tenant-context.js";

export function registerCurrentUserRoutes(server: FastifyInstance) {
  server.get("/api/me", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const user = await requireAuthenticatedUser(request, reply);
    if (!user) return;

    return { displayName: user.displayName, email: user.email };
  });
}
