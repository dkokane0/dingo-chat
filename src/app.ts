import express from "express";
import helmet from "helmet";
import cors from "cors";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import { Prisma } from "@prisma/client";
import { env } from "./config/env.js";
import { prisma } from "./config/database.js";
import { firestore } from "./config/firebase.js";
import { handleError } from "./common.js";
import { apiRateLimit } from "./middleware/rate-limit.js";
import { authRouter } from "./modules/auth.js";
import { chatRouter, userRouter } from "./modules/chats.js";
import { groupRouter } from "./modules/groups.js";

const openapi = {
  openapi: "3.1.0", info: { title: "DingoChat API", version: "1.0.0", description: "REST API for DingoChat. Message timestamps are server controlled; message pages are chronological and cursor through the oldest first." },
  servers: [{ url: "/" }], components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    schemas: { Error: { type: "object", properties: { success: { const: false }, error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } }, required: ["code", "message"] } }, required: ["success", "error"] } }
  },
  paths: {
    "/health": { get: { summary: "Liveness probe", responses: { "200": { description: "Process is running" } } } },
    "/ready": { get: { summary: "Readiness probe", responses: { "200": { description: "PostgreSQL and Firestore available" }, "503": { description: "Dependency unavailable" } } } },
    "/auth/register": { post: { summary: "Register a user", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name", "email", "password"], properties: { name: { type: "string" }, email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 } } } } } }, responses: { "201": { description: "User registered" }, "409": { description: "Email already exists" } } } },
    "/auth/login": { post: { summary: "Log in", responses: { "200": { description: "JWT and user" }, "401": { description: "Invalid credentials" } } } },
    "/auth/me": { get: { summary: "Get current user", security: [{ bearerAuth: [] }], responses: { "200": { description: "Current user" } } } },
    "/chat/create": { post: { summary: "Create or get direct chat", security: [{ bearerAuth: [] }], responses: { "201": { description: "Chat created" }, "200": { description: "Existing chat" } } } },
    "/chat/{chatId}/message/send": { post: { summary: "Send message", security: [{ bearerAuth: [] }], parameters: [{ in: "path", name: "chatId", required: true, schema: { type: "string", format: "uuid" } }, { in: "header", name: "Idempotency-Key", required: false, schema: { type: "string" } }], responses: { "201": { description: "Message persisted" } } } },
    "/chat/{chatId}/messages": { get: { summary: "List chronological messages", security: [{ bearerAuth: [] }], parameters: [{ in: "path", name: "chatId", required: true, schema: { type: "string", format: "uuid" } }, { in: "query", name: "limit", schema: { type: "integer", default: 50, maximum: 100 } }, { in: "query", name: "cursor", schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Page of messages and nextCursor" } } } },
    "/chat/{chatId}/message/{messageId}/read": { post: { summary: "Mark a message read", security: [{ bearerAuth: [] }], responses: { "200": { description: "Idempotent read receipt" } } } },
    "/chat/{chatId}/lastseen": { post: { summary: "Advance last seen position", security: [{ bearerAuth: [] }], responses: { "200": { description: "Monotonic last-seen state" } } } },
    "/chat/{chatId}/message/{messageId}": { patch: { summary: "Edit own message within 15 minutes", security: [{ bearerAuth: [] }], responses: { "200": { description: "Edited message" } } }, delete: { summary: "Soft-delete own message", security: [{ bearerAuth: [] }], responses: { "200": { description: "Deleted message" } } } },
    "/user/{userId}/chats": { get: { summary: "List the current user's chats", security: [{ bearerAuth: [] }], parameters: [{ in: "path", name: "userId", required: true, schema: { type: "string", format: "uuid" } }, { in: "query", name: "limit", schema: { type: "integer", default: 50, maximum: 100 } }, { in: "query", name: "cursor", schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Page of chats with member IDs" } } } },
    "/group/create": { post: { summary: "Create group; creator becomes administrator", security: [{ bearerAuth: [] }], responses: { "201": { description: "Group created" } } } },
    "/group/{groupId}": { get: { summary: "Get group details", security: [{ bearerAuth: [] }], responses: { "200": { description: "Group and active members" } } }, patch: { summary: "Update group details (admin)", security: [{ bearerAuth: [] }], responses: { "200": { description: "Group updated" } } } },
    "/group/{groupId}/members": { post: { summary: "Add group members (admin)", security: [{ bearerAuth: [] }], responses: { "201": { description: "Members added" } } } },
    "/group/{groupId}/members/{userId}": { delete: { summary: "Remove group member (admin)", security: [{ bearerAuth: [] }], responses: { "200": { description: "Member removed" } } } },
    "/group/{groupId}/leave": { post: { summary: "Leave group", security: [{ bearerAuth: [] }], responses: { "200": { description: "Membership ended" } } } },
    "/group/{groupId}/members/{userId}/role": { patch: { summary: "Change member role (admin)", security: [{ bearerAuth: [] }], responses: { "200": { description: "Role changed" } } } }
  }
};

export const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN.split(",").map((origin) => origin.trim()) }));
app.use(express.json({ limit: "32kb" }));
app.use(pinoHttp({ level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie"] }));
app.get("/health", (_req, res) => { res.json({ success: true, data: { status: "ok" } }); });
app.get("/ready", async (_req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; await firestore.collection("_health").limit(1).get(); res.json({ success: true, data: { status: "ready" } }); }
  catch { res.status(503).json({ success: false, error: { code: "DEPENDENCY_UNAVAILABLE", message: "A required dependency is unavailable" } }); }
});
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openapi));
app.get("/api-docs.json", (_req, res) => { res.json(openapi); });
app.use(apiRateLimit);
app.use("/auth", authRouter);
app.use("/chat", chatRouter);
app.use("/group", groupRouter);
app.use("/user", userRouter);
app.use((_req, res) => { res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Route not found" } }); });
app.use(handleError);

