import { Router } from "express";
import { ParticipantRole, ChatType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/database.js";
import { AppError, asyncRoute, assertSuppliedUserId, currentUser, validate, uuidSchema } from "../common.js";
import { authenticate } from "../middleware/authenticate.js";
import { createMessage, deleteMessage, editMessage, getMessage, listMessages, markRead, messageView, updateLastSeen } from "./messaging-store.js";

export const chatRouter = Router();
chatRouter.use(authenticate);
const directBody = z.object({ userAId: uuidSchema, userBId: uuidSchema });
const membership = async (chatId: string, userId: string) => {
  const participant = await prisma.chatParticipant.findFirst({ where: { chatId, userId, leftAt: null }, select: { id: true, role: true } });
  if (!participant) throw new AppError(403, "CHAT_ACCESS_DENIED", "You are not an active member of this chat");
  return participant;
};
const chatIdParams = z.object({ chatId: uuidSchema });
const messageParams = z.object({ chatId: uuidSchema, messageId: uuidSchema });
const textBody = z.object({ text: z.string().trim().min(1).max(4000) });

chatRouter.post("/create", asyncRoute(async (req, res) => {
  const user = currentUser(req); const { userAId, userBId } = validate(directBody, req.body);
  if (userAId === userBId) throw new AppError(400, "SELF_CHAT", "A direct chat requires two different users");
  if (user.id !== userAId && user.id !== userBId) throw new AppError(403, "IDENTITY_MISMATCH", "You must be one of the requested chat participants");
  const [low, high] = [userAId, userBId].sort();
  if (!low || !high) throw new AppError(400, "INVALID_USERS", "Both participant IDs are required");
  const existing = await prisma.chat.findUnique({ where: { directUserLow_directUserHigh: { directUserLow: low, directUserHigh: high } }, select: { id: true } });
  if (existing) { res.json({ success: true, data: { chatId: existing.id, type: "DIRECT" } }); return; }
  try {
    const chat = await prisma.chat.create({ data: { type: ChatType.DIRECT, createdById: user.id, directUserLow: low, directUserHigh: high, participants: { create: [{ userId: low }, { userId: high }] } }, select: { id: true } });
    res.status(201).json({ success: true, data: { chatId: chat.id, type: "DIRECT" } });
  } catch (error) {
    if (error instanceof Error && "code" in error && String(error.code) === "P2002") {
      const chat = await prisma.chat.findUnique({ where: { directUserLow_directUserHigh: { directUserLow: low, directUserHigh: high } }, select: { id: true } });
      if (!chat) throw error;
      res.json({ success: true, data: { chatId: chat.id, type: "DIRECT" } }); return;
    }
    throw error;
  }
}));

chatRouter.post("/:chatId/message/send", asyncRoute(async (req, res) => {
  const { chatId } = validate(chatIdParams, req.params); const user = currentUser(req);
  const body = validate(z.object({ senderId: uuidSchema, text: textBody.shape.text }), req.body); assertSuppliedUserId(body.senderId, user.id, "senderId");
  await membership(chatId, user.id);
  const key = req.header("idempotency-key");
  if (key && (key.length > 128 || !/^[\w.-]+$/.test(key))) throw new AppError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 1 to 128 safe characters");
  const message = await createMessage(chatId, user.id, body.text, key);
  res.status(201).json({ success: true, data: messageView(message) });
}));

chatRouter.get("/:chatId/messages", asyncRoute(async (req, res) => {
  const { chatId } = validate(chatIdParams, req.params); await membership(chatId, currentUser(req).id);
  const query = validate(z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: uuidSchema.optional() }), req.query);
  const page = await listMessages(chatId, query.limit, query.cursor);
  res.json({ success: true, data: page.data.map(messageView), nextCursor: page.nextCursor });
}));

chatRouter.post("/:chatId/message/:messageId/read", asyncRoute(async (req, res) => {
  const { chatId, messageId } = validate(messageParams, req.params); const user = currentUser(req);
  const { userId } = validate(z.object({ userId: uuidSchema }), req.body); assertSuppliedUserId(userId, user.id, "userId");
  await membership(chatId, user.id);
  const message = await getMessage(chatId, messageId);
  const receipt = message.senderId === user.id ? { messageId, userId, readAt: new Date().toISOString() } : await markRead(chatId, messageId, userId);
  res.json({ success: true, data: receipt });
}));

chatRouter.post("/:chatId/lastseen", asyncRoute(async (req, res) => {
  const { chatId } = validate(chatIdParams, req.params); const user = currentUser(req);
  const body = validate(z.object({ userId: uuidSchema, messageId: uuidSchema }), req.body); assertSuppliedUserId(body.userId, user.id, "userId");
  await membership(chatId, user.id);
  res.json({ success: true, data: await updateLastSeen(chatId, body.messageId, user.id) });
}));

chatRouter.patch("/:chatId/message/:messageId", asyncRoute(async (req, res) => {
  const { chatId, messageId } = validate(messageParams, req.params); const user = currentUser(req); const { text } = validate(textBody, req.body);
  await membership(chatId, user.id);
  const message = await editMessage(chatId, messageId, user.id, text, 15 * 60 * 1000);
  res.json({ success: true, data: messageView(message) });
}));

chatRouter.delete("/:chatId/message/:messageId", asyncRoute(async (req, res) => {
  const { chatId, messageId } = validate(messageParams, req.params); const user = currentUser(req);
  await membership(chatId, user.id);
  const message = await deleteMessage(chatId, messageId, user.id);
  res.json({ success: true, data: messageView(message) });
}));

export const userRouter = Router();
userRouter.use(authenticate);
userRouter.get("/:userId/chats", asyncRoute(async (req, res) => {
  const user = currentUser(req); const userId = validate(uuidSchema, req.params.userId);
  if (userId !== user.id) throw new AppError(403, "IDENTITY_MISMATCH", "You can only list your own chats");
  const params = validate(z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: uuidSchema.optional() }), req.query);
  const chats = await prisma.chat.findMany({ where: { participants: { some: { userId, leftAt: null } }, ...(params.cursor ? { id: { gt: params.cursor } } : {}) }, orderBy: { id: "asc" }, take: params.limit + 1, select: { id: true, type: true, name: true, participants: { where: { leftAt: null }, select: { userId: true } } } });
  const hasMore = chats.length > params.limit; const page = chats.slice(0, params.limit);
  res.json({ success: true, data: page.map((chat) => ({ chatId: chat.id, type: chat.type, ...(chat.name ? { name: chat.name } : {}), memberIds: chat.participants.map((participant) => participant.userId) })), nextCursor: hasMore ? page.at(-1)?.id ?? null : null });
}));

void ParticipantRole;
