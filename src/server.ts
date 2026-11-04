import { app } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./config/database.js";
import { firestore } from "./config/firebase.js";

const server = app.listen(env.PORT, () => { console.info(`DingoChat API listening on port ${env.PORT}`); });
let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.info(`Received ${signal}; shutting down`);
  server.close(async (error) => {
    try { await prisma.$disconnect(); await firestore.terminate(); }
    finally { process.exit(error ? 1 : 0); }
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
