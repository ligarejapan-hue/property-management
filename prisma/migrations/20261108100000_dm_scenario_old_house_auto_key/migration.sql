-- DMの種類「古い家」を現地調査の自動の振り分け先にする(2026-11-08 発注者決定)。データの更新だけ(表・列は変えない)。
-- 現地調査の物件は 古い家 → 使えない・削除済み・台帳に無いときは 空き家 → 発送の既定 の順(scenario-resolve.ts AUTO_KEY_BY_ROUTE)。
-- 手紙とご案内ページの社名の横の添え書きも auto_key から決める(scenario-tagline.ts: old_house=「住まい・不動産のご相談窓口」)。
-- 名前が「古い家」ちょうど・削除されていない・auto_key が空 の行が**ちょうど1件**のときだけ付ける。
-- 0件・2件以上・old_house がもう付いているときは何もしない(=現地調査は今までどおり空き家に落ちる)。行は新しく作らない
-- (文面の無い種類が自動で選ばれるのを防ぐ)。auto_key の付いた種類は削除できない(止めるときは「使わない」)。
-- 戻すとき: UPDATE "dm_scenarios" SET "auto_key" = NULL WHERE "auto_key" = 'old_house';
UPDATE "dm_scenarios" SET "auto_key" = 'old_house', "updated_at" = CURRENT_TIMESTAMP
WHERE "name" = '古い家' AND "deleted_at" IS NULL AND "auto_key" IS NULL
  AND (SELECT count(*) FROM "dm_scenarios" WHERE "name" = '古い家' AND "deleted_at" IS NULL AND "auto_key" IS NULL) = 1
  AND NOT EXISTS (SELECT 1 FROM "dm_scenarios" WHERE "auto_key" = 'old_house');
