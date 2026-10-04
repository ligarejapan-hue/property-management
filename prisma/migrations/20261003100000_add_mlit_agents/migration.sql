-- 国交省の業者一覧(2026-10-03): 宅建業者検索から夜間に集めた会社の情報と、集める進み具合。
-- 新しい表を2つ作り、名簿(agents)に「どの一覧の会社から写したか」の列(NULL 可)を足すだけ。
-- 個人名(代表者・宅建士など)の列は持たない。
-- ロールバック: コードを戻せば表と列は参照されなくなるだけ(無害)。

-- CreateTable
CREATE TABLE "mlit_agents" (
    "id" UUID NOT NULL,
    "license_key" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "license_label" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "company_kana" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "phone_digits" TEXT,
    "valid_until" TEXT,
    "listed" BOOLEAN NOT NULL DEFAULT true,
    "seen_cycle" TEXT,
    "needs_detail" BOOLEAN NOT NULL DEFAULT true,
    "detail_at" TIMESTAMP(3),
    "detail_fail_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mlit_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mlit_crawl_state" (
    "authority" TEXT NOT NULL,
    "cycle" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "next_page" INTEGER NOT NULL DEFAULT 1,
    "total_pages" INTEGER,
    "fail_streak" INTEGER NOT NULL DEFAULT 0,
    "day_off_until" TIMESTAMP(3),
    "last_error" TEXT,
    "last_run_at" TIMESTAMP(3),

    CONSTRAINT "mlit_crawl_state_pkey" PRIMARY KEY ("authority")
);

-- AlterTable
ALTER TABLE "agents" ADD COLUMN "mlit_agent_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "mlit_agents_license_key_key" ON "mlit_agents"("license_key");

-- CreateIndex
CREATE INDEX "mlit_agents_phone_digits_idx" ON "mlit_agents"("phone_digits");

-- CreateIndex
CREATE INDEX "mlit_agents_company_name_idx" ON "mlit_agents"("company_name");

-- CreateIndex
CREATE INDEX "mlit_agents_needs_detail_idx" ON "mlit_agents"("needs_detail");

-- CreateIndex
CREATE INDEX "agents_mlit_agent_id_idx" ON "agents"("mlit_agent_id");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_mlit_agent_id_fkey" FOREIGN KEY ("mlit_agent_id") REFERENCES "mlit_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
