-- 宛先不明の解除(2026-11-13 発注者決定・additive・既存の行は変えない)
-- 所有者の登記上の住所を別の住所に替えたとき、古い住所あての「宛先不明」を、送付対象から外す理由に
-- 数えないようにする印(解除した日時・人)。記録の reaction_status は 'undeliverable' のまま残す。
-- 既存の行は両方 NULL=今までどおり外す対象。
-- 戻すとき: この2列を DROP するだけ(ほかの列・表は変えていない)。
ALTER TABLE "property_dm_logs" ADD COLUMN "undeliverable_cleared_at" TIMESTAMP(3);
ALTER TABLE "property_dm_logs" ADD COLUMN "undeliverable_cleared_by" UUID;
