-- Owner memo history: append-only memos per Owner.
-- 既存の Owner.note / PropertyOwner.note は触らない（後方互換のため温存）。

CREATE TABLE "owner_memos" (
    "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
    "owner_id"   UUID         NOT NULL,
    "body"       TEXT         NOT NULL,
    "created_by" UUID         NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_memos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "owner_memos_owner_id_created_at_idx"
    ON "owner_memos"("owner_id", "created_at");

ALTER TABLE "owner_memos"
    ADD CONSTRAINT "owner_memos_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "owners"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "owner_memos"
    ADD CONSTRAINT "owner_memos_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
