CREATE TYPE "ChatType" AS ENUM ('DIRECT', 'GROUP');
CREATE TYPE "ParticipantRole" AS ENUM ('ADMIN', 'MEMBER');
CREATE TABLE "users" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "name" VARCHAR(100) NOT NULL,
  "email" VARCHAR(254) NOT NULL, "password_hash" TEXT NOT NULL, "avatar_url" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "chats" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "type" "ChatType" NOT NULL,
  "name" VARCHAR(100), "description" VARCHAR(500), "created_by_id" UUID NOT NULL,
  "direct_user_low" UUID, "direct_user_high" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "chats_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "direct_chat_pair_check" CHECK (("type" = 'DIRECT' AND "direct_user_low" IS NOT NULL AND "direct_user_high" IS NOT NULL AND "direct_user_low" < "direct_user_high") OR ("type" = 'GROUP' AND "direct_user_low" IS NULL AND "direct_user_high" IS NULL))
);
CREATE TABLE "chat_participants" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "chat_id" UUID NOT NULL, "user_id" UUID NOT NULL,
  "role" "ParticipantRole" NOT NULL DEFAULT 'MEMBER', "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "left_at" TIMESTAMP(3),
  CONSTRAINT "chat_participants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "chats_direct_user_low_direct_user_high_key" ON "chats"("direct_user_low", "direct_user_high");
CREATE INDEX "chats_created_at_idx" ON "chats"("created_at");
CREATE UNIQUE INDEX "chat_participants_active_chat_user_key" ON "chat_participants"("chat_id", "user_id") WHERE "left_at" IS NULL;
CREATE INDEX "chat_participants_user_id_left_at_chat_id_idx" ON "chat_participants"("user_id", "left_at", "chat_id");
CREATE INDEX "chat_participants_chat_id_left_at_idx" ON "chat_participants"("chat_id", "left_at");
ALTER TABLE "chats" ADD CONSTRAINT "chats_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
