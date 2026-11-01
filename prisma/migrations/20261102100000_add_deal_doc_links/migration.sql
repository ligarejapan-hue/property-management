-- お客様の書類提出。**新しい表を3つ足すだけ**(既存の行は書き換えない)。
--
-- - deal_doc_links: 提出用リンク(トークンは保存しない)。deal_doc_requests: 提出してもらう書類。deal_doc_files: 届いたファイル。
-- - 行はアプリが作る(この migration では作らない)。
--
-- 戻し方: アプリを前の版に戻すだけでよい(表は残してよい・前の版は読まない)。
--   ⚠消すときは、届いたファイル(保存先の deals/<取引>/submissions/)を先に確かめる。本人確認書類が入る。受領したものは法令の保存期間に関わる。
--     DROP TABLE "deal_doc_files"; DROP TABLE "deal_doc_requests"; DROP TABLE "deal_doc_links";

BEGIN;
-- 既存の表(deals・deal_parties・users)へ外部キーを張るときに短く書き込み止めにする。10秒待っても取れなければ諦める(失敗したら全部取り消し。やり直しは
--   `npx prisma migrate resolve --rolled-back 20261102100000_add_deal_doc_links` → `npx prisma migrate deploy`)。
SET LOCAL lock_timeout = '10s';

-- CreateTable
CREATE TABLE "deal_doc_links" (
    "id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "party_id" UUID,
    "party_role" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deal_doc_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_doc_requests" (
    "id" UUID NOT NULL,
    "link_id" UUID NOT NULL,
    "checklist_item_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reject_reason" TEXT,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deal_doc_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_doc_files" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "review_state" TEXT NOT NULL DEFAULT 'unreviewed',
    "review_state_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_doc_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deal_doc_links_public_id_key" ON "deal_doc_links"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "deal_doc_links_deal_id_party_id_key" ON "deal_doc_links"("deal_id", "party_id");

-- CreateIndex
CREATE UNIQUE INDEX "deal_doc_requests_link_id_checklist_item_id_key" ON "deal_doc_requests"("link_id", "checklist_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "deal_doc_files_storage_key_key" ON "deal_doc_files"("storage_key");

-- CreateIndex
CREATE INDEX "deal_doc_files_request_id_idx" ON "deal_doc_files"("request_id");

-- CreateIndex
CREATE INDEX "deal_doc_files_review_state_review_state_at_idx" ON "deal_doc_files"("review_state", "review_state_at");

-- AddForeignKey
ALTER TABLE "deal_doc_links" ADD CONSTRAINT "deal_doc_links_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_doc_links" ADD CONSTRAINT "deal_doc_links_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "deal_parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_doc_links" ADD CONSTRAINT "deal_doc_links_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_doc_requests" ADD CONSTRAINT "deal_doc_requests_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "deal_doc_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_doc_requests" ADD CONSTRAINT "deal_doc_requests_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_doc_files" ADD CONSTRAINT "deal_doc_files_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "deal_doc_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 状態の値を DB でも限る。新しい表なので既存の行は無い。
ALTER TABLE "deal_doc_links" ADD CONSTRAINT "deal_doc_links_party_role_check" CHECK ("party_role" IN ('seller', 'buyer'));
ALTER TABLE "deal_doc_requests" ADD CONSTRAINT "deal_doc_requests_status_check" CHECK ("status" IN ('pending', 'submitted', 'received', 'rejected'));
ALTER TABLE "deal_doc_files" ADD CONSTRAINT "deal_doc_files_review_state_check" CHECK ("review_state" IN ('unreviewed', 'received', 'rejected', 'deal_cancelled_unreviewed'));

COMMIT;
