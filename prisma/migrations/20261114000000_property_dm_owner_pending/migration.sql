-- DM判断の所有者待ちの印(2026-11-14 発注者決定・列を1つ足すだけ)
-- 所有者が入っていない物件は DM判断を「未判断」にして印を立て、所有者が入ったら見回り
-- (src/lib/dm-owner-judge)が送付可/送付不可に自動で仕分けて印を下ろす。
-- 既存の行: 「所有者あり+未判断」の物件にも1回だけ印を立てる(発注者決定=今あるものも仕分ける)。
--   所有者が無い物件の印と「送付可→未判断」は、反映後に見回りが立てる(この SQL では DM判断を変えない)。
-- 戻すとき: この列を DROP するだけ(DM判断の値は見回りが変えた分も含めて残る)。
ALTER TABLE "properties" ADD COLUMN "dm_owner_pending" BOOLEAN NOT NULL DEFAULT false;
-- これから作る物件は印ありで始める(作ってすぐ所有者が入っても仕分けられるように・@codex #728)。
-- 今ある行は上の DEFAULT false のまま(下の UPDATE で立てる行だけ true)。
ALTER TABLE "properties" ALTER COLUMN "dm_owner_pending" SET DEFAULT true;

UPDATE "properties" p
SET "dm_owner_pending" = true
WHERE p."dm_status" = 'hold'
  AND p."is_archived" = false
  AND EXISTS (SELECT 1 FROM "property_owners" po WHERE po."property_id" = p."id");
