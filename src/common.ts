import type { Request, Response, NextFunction } from "express";
import { z, ZodError } from "zod";
import { Prisma } from "@prisma/client";

export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export interface AuthUser { id: string; email: string }
declare global { namespace Express { interface Request { authUser?: AuthUser } } }
export const uuidSchema = z.string().uuid();
export const asyncRoute = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => { void fn(req, res, next).catch(next); };
export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, "VALIDATION_ERROR", result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  return result.data;
}
export function currentUser(req: Request): AuthUser {
  if (!req.authUser) throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  return req.authUser;
}
export function assertSuppliedUserId(supplied: string, actual: string, field: string): void {
  if (supplied !== actual) throw new AppError(403, "IDENTITY_MISMATCH", `${field} must match the authenticated user`);
}
export function handleError(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof AppError) { res.status(error.status).json({ success: false, error: { code: error.code, message: error.message } }); return; }
  if (error instanceof ZodError) { res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Request validation failed" } }); return; }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") { res.status(409).json({ success: false, error: { code: "CONFLICT", message: "A resource with these details already exists" } }); return; }
    if (["P1001", "P1002", "P1008"].includes(error.code)) { res.status(503).json({ success: false, error: { code: "DATABASE_UNAVAILABLE", message: "Database is temporarily unavailable" } }); return; }
  }
  if (error instanceof Error && (error.message.includes("Firestore") || error.message.includes("firestore") || error.message.includes("ECONNREFUSED"))) {
    res.status(503).json({ success: false, error: { code: "MESSAGING_STORE_UNAVAILABLE", message: "Messaging service is temporarily unavailable" } }); return;
  }
  res.status(500).json({ success: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
}
