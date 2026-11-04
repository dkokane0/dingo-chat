import { Timestamp, type DocumentSnapshot } from "firebase-admin/firestore";
import { firestore } from "../config/firebase.js";
import { AppError } from "../common.js";

export interface Message { id: string; chatId: string; senderId: string; text: string; createdAt: Timestamp; updatedAt: Timestamp | null; editedAt: Timestamp | null; deletedAt: Timestamp | null }
const db = firestore;
const messages = (chatId: string) => db.collection("chats").doc(chatId).collection("messages");
function fromDoc(doc: DocumentSnapshot): Message {
  const data = doc.data() as Omit<Message, "id">;
  return { id: doc.id, ...data };
}
export function messageView(message: Message): Record<string, unknown> {
  return { id: message.id, chatId: message.chatId, senderId: message.senderId, text: message.deletedAt ? "" : message.text, createdAt: message.createdAt.toDate().toISOString(), updatedAt: message.updatedAt?.toDate().toISOString() ?? null, editedAt: message.editedAt?.toDate().toISOString() ?? null, deletedAt: message.deletedAt?.toDate().toISOString() ?? null, deleted: message.deletedAt !== null };
}
export async function createMessage(chatId: string, senderId: string, text: string, idempotencyKey?: string): Promise<Message> {
  const id = idempotencyKey ?? crypto.randomUUID();
  const ref = messages(chatId).doc(id);
  if (idempotencyKey) {
    return db.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) {
        const old = fromDoc(existing);
        if (old.senderId !== senderId || (old.text !== text && !old.deletedAt)) throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for a different message");
        return old;
      }
      const createdAt = Timestamp.now();
      const message: Message = { id, chatId, senderId, text, createdAt, updatedAt: null, editedAt: null, deletedAt: null };
      transaction.create(ref, message);
      return message;
    });
  }
  const message: Message = { id, chatId, senderId, text, createdAt: Timestamp.now(), updatedAt: null, editedAt: null, deletedAt: null };
  await ref.create(message);
  return message;
}
export async function listMessages(chatId: string, limit: number, cursor?: string): Promise<{ data: Message[]; nextCursor: string | null }> {
  let query = messages(chatId).orderBy("createdAt", "asc").orderBy("__name__", "asc").limit(limit + 1);
  if (cursor) {
    const snapshot = await messages(chatId).doc(cursor).get();
    if (!snapshot.exists) throw new AppError(400, "INVALID_CURSOR", "Cursor message does not exist");
    query = query.startAfter(snapshot);
  }
    const docs = (await query.get()).docs;
  const hasMore = docs.length > limit;
  const page = docs.slice(0, limit).map(fromDoc);
  return { data: page, nextCursor: hasMore ? page.at(-1)?.id ?? null : null };
}
export async function getMessage(chatId: string, messageId: string): Promise<Message> {
  const doc = await messages(chatId).doc(messageId).get();
  if (!doc.exists) throw new AppError(404, "MESSAGE_NOT_FOUND", "Message not found");
  return fromDoc(doc);
}
export async function markRead(chatId: string, messageId: string, userId: string): Promise<{ messageId: string; userId: string; readAt: string }> {
  const messageRef = messages(chatId).doc(messageId);
  const receiptRef = db.collection("chats").doc(chatId).collection("readReceipts").doc(`${messageId}_${userId}`);
  return db.runTransaction(async (transaction) => {
    const [messageDoc, receiptDoc] = await Promise.all([transaction.get(messageRef), transaction.get(receiptRef)]);
    if (!messageDoc.exists) throw new AppError(404, "MESSAGE_NOT_FOUND", "Message not found");
    if (receiptDoc.exists) {
      const old = receiptDoc.data() as { readAt: Timestamp };
      return { messageId, userId, readAt: old.readAt.toDate().toISOString() };
    }
    const readAt = Timestamp.now();
    transaction.create(receiptRef, { messageId, userId, readAt });
    return { messageId, userId, readAt: readAt.toDate().toISOString() };
  });
}
export async function updateLastSeen(chatId: string, messageId: string, userId: string): Promise<{ userId: string; messageId: string; updatedAt: string }> {
  const messageRef = messages(chatId).doc(messageId);
  const lastSeenRef = db.collection("chats").doc(chatId).collection("lastSeen").doc(userId);
  return db.runTransaction(async (transaction) => {
    const [messageDoc, lastSeenDoc] = await Promise.all([transaction.get(messageRef), transaction.get(lastSeenRef)]);
    if (!messageDoc.exists) throw new AppError(404, "MESSAGE_NOT_FOUND", "Message not found");
    const candidate = fromDoc(messageDoc);
    let current: Message | undefined;
    if (lastSeenDoc.exists) {
      const lastSeen = lastSeenDoc.data() as { messageId: string };
      if (lastSeen.messageId === messageId) return { userId, messageId, updatedAt: (lastSeenDoc.data()?.updatedAt as Timestamp).toDate().toISOString() };
      const currentDoc = await transaction.get(messageRef.parent.doc(lastSeen.messageId));
      if (currentDoc.exists) current = fromDoc(currentDoc);
    }
    if (current && compareMessageOrder(candidate, current) < 0) return { userId, messageId: current.id, updatedAt: (lastSeenDoc.data()?.updatedAt as Timestamp).toDate().toISOString() };
    const updatedAt = Timestamp.now();
    transaction.set(lastSeenRef, { userId, messageId, updatedAt });
    return { userId, messageId, updatedAt: updatedAt.toDate().toISOString() };
  });
}
function compareMessageOrder(a: Message, b: Message): number {
  const byTime = a.createdAt.toMillis() - b.createdAt.toMillis();
  return byTime || a.id.localeCompare(b.id);
}
export async function editMessage(chatId: string, messageId: string, senderId: string, text: string, editWindowMs: number): Promise<Message> {
  const ref = messages(chatId).doc(messageId);
  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    if (!doc.exists) throw new AppError(404, "MESSAGE_NOT_FOUND", "Message not found");
    const message = fromDoc(doc);
    if (message.senderId !== senderId) throw new AppError(403, "FORBIDDEN", "Only the sender can edit this message");
    if (message.deletedAt) throw new AppError(409, "MESSAGE_DELETED", "Deleted messages cannot be edited");
    if (Timestamp.now().toMillis() - message.createdAt.toMillis() > editWindowMs) throw new AppError(409, "EDIT_WINDOW_EXPIRED", "Messages can only be edited within 15 minutes");
    const editedAt = Timestamp.now();
    const updated = { ...message, text, updatedAt: editedAt, editedAt };
    transaction.update(ref, { text, updatedAt: editedAt, editedAt });
    return updated;
  });
}
export async function deleteMessage(chatId: string, messageId: string, senderId: string): Promise<Message> {
  const ref = messages(chatId).doc(messageId);
  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    if (!doc.exists) throw new AppError(404, "MESSAGE_NOT_FOUND", "Message not found");
    const message = fromDoc(doc);
    if (message.senderId !== senderId) throw new AppError(403, "FORBIDDEN", "Only the sender can delete this message");
    if (message.deletedAt) return message;
    const deletedAt = Timestamp.now();
    transaction.update(ref, { deletedAt, updatedAt: deletedAt, text: "" });
    return { ...message, text: "", deletedAt, updatedAt: deletedAt };
  });
}
