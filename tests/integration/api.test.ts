import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(), userCreate: vi.fn(),
  chatFindUnique: vi.fn(), chatCreate: vi.fn(),
  participantFindFirst: vi.fn(),
  createMessage: vi.fn(), listMessages: vi.fn()
}));

vi.mock("../../src/config/database.js", () => ({ prisma: {
  user: { findUnique: mocks.userFindUnique, create: mocks.userCreate },
  chat: { findUnique: mocks.chatFindUnique, create: mocks.chatCreate },
  chatParticipant: { findFirst: mocks.participantFindFirst },
  $queryRaw: vi.fn()
} }));
vi.mock("../../src/config/firebase.js", () => ({ firestore: { collection: vi.fn(() => ({ limit: vi.fn(() => ({ get: vi.fn() })) })) } }));
vi.mock("../../src/modules/messaging-store.js", () => ({
  createMessage: mocks.createMessage, listMessages: mocks.listMessages,
  getMessage: vi.fn(), markRead: vi.fn(), updateLastSeen: vi.fn(), editMessage: vi.fn(), deleteMessage: vi.fn(), messageView: (message: unknown) => message
}));

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.JWT_SECRET = "test-secret-that-is-long-enough-to-pass-32-characters";

const { app } = await import("../../src/app.js");
const userId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const chatId = "00000000-0000-4000-8000-000000000003";
const token = jwt.sign({ email: "one@example.com" }, process.env.JWT_SECRET!, { subject: userId, expiresIn: "1h" });

describe("chat API", () => {
  beforeEach(() => vi.clearAllMocks());
  it("rejects an invalid direct chat payload", async () => {
    const response = await request(app).post("/chat/create").set("Authorization", `Bearer ${token}`).send({ userAId: "bad", userBId: otherId });
    expect(response.status).toBe(400);
    expect(mocks.chatCreate).not.toHaveBeenCalled();
  });
  it("returns an existing direct chat", async () => {
    mocks.chatFindUnique.mockResolvedValue({ id: chatId });
    const response = await request(app).post("/chat/create").set("Authorization", `Bearer ${token}`).send({ userAId: userId, userBId: otherId });
    expect(response.status).toBe(200);
    expect(response.body.data.chatId).toBe(chatId);
    expect(mocks.chatCreate).not.toHaveBeenCalled();
  });
  it("uses the unique pair result after a concurrent create conflict", async () => {
    mocks.chatFindUnique.mockResolvedValueOnce(null);
    const conflict = Object.assign(new Error("duplicate"), { code: "P2002" });
    mocks.chatCreate.mockRejectedValue(conflict);
    mocks.chatFindUnique.mockResolvedValueOnce({ id: chatId });
    const response = await request(app).post("/chat/create").set("Authorization", `Bearer ${token}`).send({ userAId: userId, userBId: otherId });
    expect(response.status).toBe(200);
    expect(response.body.data.chatId).toBe(chatId);
  });
  it("rejects a sender ID that differs from the authenticated user", async () => {
    const response = await request(app).post(`/chat/${chatId}/message/send`).set("Authorization", `Bearer ${token}`).send({ senderId: otherId, text: "hello" });
    expect(response.status).toBe(403);
    expect(mocks.participantFindFirst).not.toHaveBeenCalled();
  });
  it("checks active membership before sending", async () => {
    mocks.participantFindFirst.mockResolvedValue(null);
    const response = await request(app).post(`/chat/${chatId}/message/send`).set("Authorization", `Bearer ${token}`).send({ senderId: userId, text: "hello" });
    expect(response.status).toBe(403);
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });
  it("returns a chronological message page and its cursor", async () => {
    mocks.participantFindFirst.mockResolvedValue({ id: "p1", role: "MEMBER" });
    mocks.listMessages.mockResolvedValue({ data: [{ id: "m1" }, { id: "m2" }], nextCursor: "m2" });
    const response = await request(app).get(`/chat/${chatId}/messages?limit=2`).set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.data.map((item: { id: string }) => item.id)).toEqual(["m1", "m2"]);
    expect(response.body.nextCursor).toBe("m2");
  });
  it("does not call the store for a whitespace-only message", async () => {
    const response = await request(app).post(`/chat/${chatId}/message/send`).set("Authorization", `Bearer ${token}`).send({ senderId: userId, text: "   " });
    expect(response.status).toBe(400);
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });
});
