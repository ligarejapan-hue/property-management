-- 業者からの反響の受付: 二重登録を防ぐ鍵(通信が切れて押し直しても、同じ鍵なら1回目の分を返す)。
-- 列を足すだけ(NULL 可・既存行は NULL のまま)。一意は「登録者×鍵」(NULL どうしは重ならない)。
-- ロールバック: コードを戻せば列は参照されなくなるだけ(無害)。

-- AlterTable
ALTER TABLE "agent_inquiries" ADD COLUMN "client_token" UUID;

-- AlterTable
ALTER TABLE "agents" ADD COLUMN "client_token" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "agent_inquiries_created_by_id_client_token_key" ON "agent_inquiries"("created_by_id", "client_token");

-- CreateIndex
CREATE UNIQUE INDEX "agents_created_by_id_client_token_key" ON "agents"("created_by_id", "client_token");
