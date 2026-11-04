import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { AppError, type AuthUser } from "../common.js";

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const [scheme, token] = (req.header("authorization") ?? "").split(" ");
  if (scheme !== "Bearer" || !token) { next(new AppError(401, "UNAUTHORIZED", "Authentication required")); return; }
  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (typeof payload === "string" || typeof payload.sub !== "string" || typeof payload.email !== "string") throw new Error("Invalid token payload");
    req.authUser = { id: payload.sub, email: payload.email } satisfies AuthUser;
    next();
  } catch { next(new AppError(401, "INVALID_TOKEN", "Bearer token is invalid or expired")); }
}
