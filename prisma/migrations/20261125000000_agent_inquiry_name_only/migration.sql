-- 反響の受付: 名簿に入れずに業者の名前だけで受け付けられるようにする(2026-11-25 発注者「代表電話がない会社・宅建業を持っていない会社もある」)。
-- 足す・NULL を許すだけ(今の行は全部 agent_id が入っているので、そのまま条件を満たす)。

-- AlterTable
ALTER TABLE "agent_inquiries" ALTER COLUMN "agent_id" DROP NOT NULL;
ALTER TABLE "agent_inquiries" ADD COLUMN "agent_name_text" TEXT;

-- 名簿の業者か、名前のどちらかは必ずある(業者の分からない反響を作らない)。
ALTER TABLE "agent_inquiries" ADD CONSTRAINT "agent_inquiries_agent_or_name_check"
  CHECK ("agent_id" IS NOT NULL OR ("agent_name_text" IS NOT NULL AND btrim("agent_name_text") <> ''));
