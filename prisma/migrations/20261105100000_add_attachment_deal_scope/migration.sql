-- 添付ファイルがどの取引の書類か(買取再販の仕入/売却を分ける・2026-11-04 発注者 案A)。
-- 列を足すだけ。既存の行は deal_id=NULL・deal_common=false(=未区分)のまま=書き換えない。
-- 振り分けは画面で推定を見て人が確定する(推定はデータに書かない)。
ALTER TABLE "attachments" ADD COLUMN "deal_id" UUID;
ALTER TABLE "attachments" ADD COLUMN "deal_common" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "attachments_deal_id_idx" ON "attachments"("deal_id");

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_deal_id_fkey"
  FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
