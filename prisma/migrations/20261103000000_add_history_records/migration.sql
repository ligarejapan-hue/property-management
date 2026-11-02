-- 経緯に足りなかった記録。**足すだけ**(既存の行は書き換えない)。
--
-- change_logs.property_id: 所有者の紐づけ解除を物件から引くための列。つながりの行は解除で消えるので、id では引けない。
--   これからの解除だけに入る。過去の解除は物件が分からないので戻らない。
-- deal_doc_review_events: 受領・差し戻しの履歴。deal_doc_requests は最新だけを持つので、再提出で前の差し戻しが消える。
--   今ある最新の確認は写す(経緯をこの表だけから読むため)。
--
-- 戻し方: アプリを前の版に戻すだけでよい(列と表は残してよい・前の版は読まない)。
--   消すときは次を流す(これからの解除の物件と、確認の履歴を失う):
--     DROP TABLE "deal_doc_review_events";
--     DROP INDEX "change_logs_property_id_changed_at_idx";
--     ALTER TABLE "change_logs" DROP COLUMN "property_id";

ALTER TABLE "change_logs" ADD COLUMN "property_id" UUID;
CREATE INDEX "change_logs_property_id_changed_at_idx" ON "change_logs"("property_id", "changed_at");

CREATE TABLE "deal_doc_review_events" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "reviewed_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_doc_review_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deal_doc_review_events_request_id_created_at_idx" ON "deal_doc_review_events"("request_id", "created_at");

ALTER TABLE "deal_doc_review_events" ADD CONSTRAINT "deal_doc_review_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "deal_doc_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deal_doc_review_events" ADD CONSTRAINT "deal_doc_review_events_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "deal_doc_review_events" ("id", "request_id", "action", "reason", "reviewed_by_id", "created_at")
SELECT gen_random_uuid(), "id", "status", "reject_reason", "reviewed_by_id", "reviewed_at"
FROM "deal_doc_requests"
WHERE "status" IN ('received', 'rejected') AND "reviewed_at" IS NOT NULL;
