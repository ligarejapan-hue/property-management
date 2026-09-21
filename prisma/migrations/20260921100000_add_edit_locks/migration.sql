-- CreateEnum
CREATE TYPE "EditLockResource" AS ENUM ('property', 'owner');

-- CreateTable
CREATE TABLE "edit_locks" (
    "id" UUID NOT NULL,
    "resource_type" "EditLockResource" NOT NULL,
    "resource_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "screen_token_hash" TEXT NOT NULL,
    "acquired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "force_released_at" TIMESTAMP(3),
    "force_released_by" UUID,

    CONSTRAINT "edit_locks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "edit_locks_resource_type_resource_id_key" ON "edit_locks"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "edit_locks_user_id_idx" ON "edit_locks"("user_id");

-- AddForeignKey
ALTER TABLE "edit_locks" ADD CONSTRAINT "edit_locks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
