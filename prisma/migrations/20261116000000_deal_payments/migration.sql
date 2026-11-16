-- お金の受け渡し(お金ごとの払い方・振込先・2026-11-16 発注者)。列を1つ足すだけ(今ある行は {}=全部「未定」)。
-- 戻すとき: この列を DROP するだけ(ほかの列は触らない)。
ALTER TABLE "deals" ADD COLUMN "payments" JSONB NOT NULL DEFAULT '{}';
