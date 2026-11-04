import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.SEED_EMAIL;
  const password = process.env.SEED_PASSWORD;
  if (!email || !password) throw new Error("Set SEED_EMAIL and SEED_PASSWORD to create a seed user.");
  const user = await prisma.user.upsert({ where: { email }, update: {}, create: { name: "DingoChat Developer", email, passwordHash: await bcrypt.hash(password, 12) } });
  console.info(`Seeded user ${user.id}`);
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
