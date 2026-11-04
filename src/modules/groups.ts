import { Router } from "express";
import { ChatType, ParticipantRole, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/database.js";
import { AppError, asyncRoute, currentUser, validate, uuidSchema } from "../common.js";
import { authenticate } from "../middleware/authenticate.js";

export const groupRouter = Router();
groupRouter.use(authenticate);
const groupIdSchema = z.object({ groupId: uuidSchema });
async function activeGroup(groupId: string): Promise<{ id: string; type: ChatType; name: string | null; description: string | null }> {
  const chat = await prisma.chat.findUnique({ where: { id: groupId }, select: { id: true, type: true, name: true, description: true } });
  if (!chat || chat.type !== ChatType.GROUP) throw new AppError(404, "GROUP_NOT_FOUND", "Group not found");
  return chat;
}
async function groupMember(groupId: string, userId: string) {
  const item = await prisma.chatParticipant.findFirst({ where: { chatId: groupId, userId, leftAt: null }, select: { id: true, role: true } });
  if (!item) throw new AppError(403, "GROUP_ACCESS_DENIED", "You are not an active group member");
  return item;
}
async function requireAdmin(groupId: string, userId: string) {
  const item = await groupMember(groupId, userId);
  if (item.role !== ParticipantRole.ADMIN) throw new AppError(403, "ADMIN_REQUIRED", "Only group administrators can perform this action");
  return item;
}

groupRouter.post("/create", asyncRoute(async (req, res) => {
  const user = currentUser(req); const body = validate(z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(500).optional(), memberIds: z.array(uuidSchema).max(200).default([]) }), req.body);
  const memberIds = [...new Set([...body.memberIds, user.id])];
  const found = await prisma.user.count({ where: { id: { in: memberIds } } });
  if (found !== memberIds.length) throw new AppError(400, "INVALID_MEMBERS", "One or more users do not exist");
  const chat = await prisma.chat.create({ data: { type: ChatType.GROUP, name: body.name, ...(body.description ? { description: body.description } : {}), createdById: user.id, participants: { create: memberIds.map((userId) => ({ userId, role: userId === user.id ? ParticipantRole.ADMIN : ParticipantRole.MEMBER })) } }, select: { id: true, type: true, name: true, description: true } });
  res.status(201).json({ success: true, data: { ...chat, memberIds } });
}));

groupRouter.get("/:groupId", asyncRoute(async (req, res) => {
  const { groupId } = validate(groupIdSchema, req.params); const user = currentUser(req); const group = await activeGroup(groupId); await groupMember(groupId, user.id);
  const members = await prisma.chatParticipant.findMany({ where: { chatId: groupId, leftAt: null }, select: { userId: true, role: true, joinedAt: true }, orderBy: { joinedAt: "asc" } });
  res.json({ success: true, data: { ...group, members } });
}));

groupRouter.patch("/:groupId", asyncRoute(async (req, res) => {
  const { groupId } = validate(groupIdSchema, req.params); const user = currentUser(req); await activeGroup(groupId); await requireAdmin(groupId, user.id);
  const body = validate(z.object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().trim().max(500).nullable().optional() }).refine((data) => Object.keys(data).length > 0), req.body);
  const group = await prisma.chat.update({ where: { id: groupId }, data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description } : {}) }, select: { id: true, name: true, description: true, type: true } });
  res.json({ success: true, data: group });
}));

groupRouter.post("/:groupId/members", asyncRoute(async (req, res) => {
  const { groupId } = validate(groupIdSchema, req.params); const user = currentUser(req); await activeGroup(groupId); await requireAdmin(groupId, user.id);
  const { memberIds } = validate(z.object({ memberIds: z.array(uuidSchema).min(1).max(200) }), req.body);
  if (new Set(memberIds).size !== memberIds.length) throw new AppError(400, "DUPLICATE_MEMBERS", "memberIds must not contain duplicates");
  const found = await prisma.user.count({ where: { id: { in: memberIds } } });
  if (found !== memberIds.length) throw new AppError(400, "INVALID_MEMBERS", "One or more users do not exist");
  try {
    const created = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${groupId}))`;
      const active = await tx.chatParticipant.findMany({ where: { chatId: groupId, userId: { in: memberIds }, leftAt: null }, select: { userId: true } });
      if (active.length) throw new AppError(409, "ALREADY_MEMBER", "One or more users are already active group members");
      return Promise.all(memberIds.map(async (memberId) => {
        const old = await tx.chatParticipant.findFirst({ where: { chatId: groupId, userId: memberId }, select: { id: true } });
        return old
          ? tx.chatParticipant.update({ where: { id: old.id }, data: { leftAt: null, joinedAt: new Date(), role: ParticipantRole.MEMBER }, select: { userId: true, role: true, joinedAt: true } })
          : tx.chatParticipant.create({ data: { chatId: groupId, userId: memberId }, select: { userId: true, role: true, joinedAt: true } });
      }));
    });
    res.status(201).json({ success: true, data: created });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new AppError(409, "ALREADY_MEMBER", "A user is already an active or historical member of this group");
    throw error;
  }
}));

groupRouter.delete("/:groupId/members/:userId", asyncRoute(async (req, res) => {
  const { groupId } = validate(groupIdSchema, req.params); const userId = validate(uuidSchema, req.params.userId); const user = currentUser(req);
  await activeGroup(groupId); await requireAdmin(groupId, user.id);
  if (user.id === userId) throw new AppError(400, "USE_LEAVE_ENDPOINT", "Use the leave endpoint to remove yourself");
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${groupId}))`;
    const target = await tx.chatParticipant.findFirst({ where: { chatId: groupId, userId, leftAt: null } });
    if (!target) throw new AppError(404, "MEMBER_NOT_FOUND", "Active group member not found");
    if (target.role === ParticipantRole.ADMIN) {
      const admins = await tx.chatParticipant.count({ where: { chatId: groupId, role: ParticipantRole.ADMIN, leftAt: null } });
      if (admins <= 1) throw new AppError(409, "LAST_ADMIN", "Promote another administrator before removing the last administrator");
    }
    await tx.chatParticipant.update({ where: { id: target.id }, data: { leftAt: new Date() } });
  });
  res.json({ success: true, data: { groupId, userId, removed: true } });
}));

groupRouter.post("/:groupId/leave", asyncRoute(async (req, res) => {
  const { groupId } = validate(groupIdSchema, req.params); const user = currentUser(req); await activeGroup(groupId);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${groupId}))`;
    const participant = await tx.chatParticipant.findFirst({ where: { chatId: groupId, userId: user.id, leftAt: null } });
    if (!participant) throw new AppError(404, "MEMBER_NOT_FOUND", "Active group membership not found");
    if (participant.role === ParticipantRole.ADMIN) {
      const adminCount = await tx.chatParticipant.count({ where: { chatId: groupId, role: ParticipantRole.ADMIN, leftAt: null } });
      if (adminCount === 1) throw new AppError(409, "LAST_ADMIN", "Promote another administrator before leaving");
    }
    await tx.chatParticipant.update({ where: { id: participant.id }, data: { leftAt: new Date() } });
  });
  res.json({ success: true, data: { groupId, userId: user.id, left: true } });
}));

groupRouter.patch("/:groupId/members/:userId/role", asyncRoute(async (req, res) => {
  const { groupId } = validate(groupIdSchema, req.params); const userId = validate(uuidSchema, req.params.userId); const user = currentUser(req);
  await activeGroup(groupId); await requireAdmin(groupId, user.id);
  const { role } = validate(z.object({ role: z.nativeEnum(ParticipantRole) }), req.body);
  if (user.id === userId && role === ParticipantRole.MEMBER) throw new AppError(409, "SELF_DEMOTION", "An administrator cannot demote themselves");
  const changed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${groupId}))`;
    const target = await tx.chatParticipant.findFirst({ where: { chatId: groupId, userId, leftAt: null } });
    if (!target) throw new AppError(404, "MEMBER_NOT_FOUND", "Active group member not found");
    if (target.role === ParticipantRole.ADMIN && role === ParticipantRole.MEMBER) {
      const count = await tx.chatParticipant.count({ where: { chatId: groupId, role: ParticipantRole.ADMIN, leftAt: null } });
      if (count <= 1) throw new AppError(409, "LAST_ADMIN", "A group must retain at least one administrator");
    }
    return tx.chatParticipant.update({ where: { id: target.id }, data: { role }, select: { userId: true, role: true } });
  });
  res.json({ success: true, data: changed });
}));
