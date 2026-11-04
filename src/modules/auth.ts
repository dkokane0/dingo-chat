import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "../config/database.js";
import { env } from "../config/env.js";
import { AppError, asyncRoute, currentUser, validate } from "../common.js";
import { authenticate } from "../middleware/authenticate.js";
import { authRateLimit } from "../middleware/rate-limit.js";

export const authRouter = Router();
const credentials = z.object({ email: z.string().email().max(254).transform((email) => email.toLowerCase()), password: z.string().min(8).max(128) });
const registerBody = credentials.extend({ name: z.string().trim().min(1).max(100), avatarUrl: z.string().url().max(2048).optional() });
function tokenFor(user: { id: string; email: string }): string {
  const options: jwt.SignOptions = { subject: user.id, expiresIn: env.JWT_EXPIRES_IN as NonNullable<jwt.SignOptions["expiresIn"]> };
  return jwt.sign({ email: user.email }, env.JWT_SECRET, options);
}

authRouter.post("/register", authRateLimit, asyncRoute(async (req, res) => {
  const body = validate(registerBody, req.body);
  const user = await prisma.user.create({ data: { name: body.name, email: body.email, passwordHash: await bcrypt.hash(body.password, env.BCRYPT_ROUNDS), ...(body.avatarUrl ? { avatarUrl: body.avatarUrl } : {}) }, select: { id: true, name: true, email: true, avatarUrl: true, createdAt: true } });
  res.status(201).json({ success: true, data: { user, token: tokenFor(user) } });
}));

authRouter.post("/login", authRateLimit, asyncRoute(async (req, res) => {
  const body = validate(credentials, req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  const { passwordHash: _passwordHash, ...safeUser } = user;
  res.json({ success: true, data: { user: safeUser, token: tokenFor(user) } });
}));

authRouter.get("/me", authenticate, asyncRoute(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: currentUser(req).id }, select: { id: true, name: true, email: true, avatarUrl: true, createdAt: true } });
  if (!user) throw new AppError(404, "USER_NOT_FOUND", "User not found");
  res.json({ success: true, data: user });
}));
