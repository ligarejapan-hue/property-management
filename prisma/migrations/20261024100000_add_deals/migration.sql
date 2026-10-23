-- CreateTable
CREATE TABLE "deals" (
    "id" UUID NOT NULL,
    "deal_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "business_type" TEXT NOT NULL,
    "trade_side" TEXT,
    "status" TEXT NOT NULL DEFAULT 'considering',
    "assignee_id" UUID,
    "licensed_agent_id" UUID,
    "sales_staff_id" UUID,
    "ops_staff_id" UUID,
    "property_id" UUID,
    "property_kind" TEXT,
    "has_oc" BOOLEAN NOT NULL DEFAULT false,
    "contract_at" TIMESTAMP(3),
    "contract_place" TEXT,
    "settlement_at" TIMESTAMP(3),
    "settlement_place" TEXT,
    "price" BIGINT,
    "building_tax" BIGINT,
    "deposit" BIGINT,
    "tax_rate_bp" INTEGER NOT NULL DEFAULT 1000,
    "property_snapshot" JSONB NOT NULL DEFAULT '{}',
    "assessments" JSONB NOT NULL DEFAULT '[]',
    "costs" JSONB NOT NULL DEFAULT '{}',
    "counterparty_broker" JSONB NOT NULL DEFAULT '{}',
    "settlement_terms" JSONB NOT NULL DEFAULT '{}',
    "leases" JSONB NOT NULL DEFAULT '[]',
    "plan_inputs" JSONB NOT NULL DEFAULT '{}',
    "checklist_state" JSONB NOT NULL DEFAULT '{}',
    "overrides" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_parties" (
    "id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "party_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "representative" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "share_num" INTEGER,
    "share_den" INTEGER,
    "is_self" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deal_parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_documents" (
    "id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "doc_type" TEXT NOT NULL,
    "variant" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by_id" UUID NOT NULL,
    "input_snapshot" JSONB NOT NULL,
    "calc_snapshot" JSONB NOT NULL,
    "pdf_key" TEXT,
    "xlsx_key" TEXT,
    "file_base_name" TEXT NOT NULL,

    CONSTRAINT "deal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "representative_title" TEXT,
    "representative_name" TEXT,
    "bank_account" JSONB NOT NULL DEFAULT '{}',
    "logo_key" TEXT,
    "seal_key" TEXT,
    "texts" JSONB NOT NULL DEFAULT '{}',
    "checklist_items" JSONB NOT NULL DEFAULT '[]',
    "property_kinds" JSONB NOT NULL DEFAULT '[]',
    "section_matrix" JSONB NOT NULL DEFAULT '{}',
    "brokerage_method" TEXT NOT NULL DEFAULT 'cap',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "deal_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_rate_tables" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "content" JSONB NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_rate_tables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deals_deal_no_key" ON "deals"("deal_no");

-- CreateIndex
CREATE INDEX "deals_status_settlement_at_idx" ON "deals"("status", "settlement_at");

-- CreateIndex
CREATE INDEX "deals_business_type_idx" ON "deals"("business_type");

-- CreateIndex
CREATE INDEX "deals_assignee_id_idx" ON "deals"("assignee_id");

-- CreateIndex
CREATE INDEX "deals_property_id_idx" ON "deals"("property_id");

-- CreateIndex
CREATE INDEX "deals_created_at_idx" ON "deals"("created_at");

-- CreateIndex
CREATE INDEX "deal_parties_deal_id_role_sort_order_idx" ON "deal_parties"("deal_id", "role", "sort_order");

-- CreateIndex
CREATE INDEX "deal_documents_deal_id_issued_at_idx" ON "deal_documents"("deal_id", "issued_at");

-- CreateIndex
CREATE UNIQUE INDEX "deal_documents_deal_id_doc_type_variant_version_key" ON "deal_documents"("deal_id", "doc_type", "variant", "version");

-- CreateIndex
CREATE INDEX "deal_rate_tables_kind_valid_from_idx" ON "deal_rate_tables"("kind", "valid_from");

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_licensed_agent_id_fkey" FOREIGN KEY ("licensed_agent_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_sales_staff_id_fkey" FOREIGN KEY ("sales_staff_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_ops_staff_id_fkey" FOREIGN KEY ("ops_staff_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_parties" ADD CONSTRAINT "deal_parties_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_documents" ADD CONSTRAINT "deal_documents_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_documents" ADD CONSTRAINT "deal_documents_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 税率・税額の表の初期データ(src/lib/deals/rate-tables.ts の INITIAL_RATE_TABLES と同じ)。
INSERT INTO "deal_rate_tables" ("id", "kind", "valid_from", "valid_to", "content", "updated_at")
SELECT gen_random_uuid(), v.kind, v.valid_from, v.valid_to, v.content, now()
FROM (VALUES
  ('consumption_tax', DATE '2019-10-01', NULL, '{"rateBp":1000}'::jsonb),
  ('brokerage_tiers', DATE '2024-07-01', NULL, '{"tiers":[{"upTo":2000000,"rateBp":500},{"upTo":4000000,"rateBp":400},{"upTo":null,"rateBp":300}],"lowCostSpecial":{"priceLimit":8000000,"feeCap":300000}}'::jsonb),
  ('stamp_contract', DATE '2014-04-01', DATE '2027-03-31', '{"brackets":[{"upTo":9999,"tax":0},{"upTo":100000,"tax":200},{"upTo":500000,"tax":200},{"upTo":1000000,"tax":500},{"upTo":5000000,"tax":1000},{"upTo":10000000,"tax":5000},{"upTo":50000000,"tax":10000},{"upTo":100000000,"tax":30000},{"upTo":500000000,"tax":60000},{"upTo":1000000000,"tax":160000},{"upTo":5000000000,"tax":320000},{"upTo":null,"tax":480000}]}'::jsonb),
  ('stamp_contract', DATE '2027-04-01', NULL, '{"brackets":[{"upTo":9999,"tax":0},{"upTo":100000,"tax":200},{"upTo":500000,"tax":400},{"upTo":1000000,"tax":1000},{"upTo":5000000,"tax":2000},{"upTo":10000000,"tax":10000},{"upTo":50000000,"tax":20000},{"upTo":100000000,"tax":60000},{"upTo":500000000,"tax":100000},{"upTo":1000000000,"tax":200000},{"upTo":5000000000,"tax":400000},{"upTo":null,"tax":600000}]}'::jsonb),
  ('stamp_receipt', DATE '2014-04-01', NULL, '{"brackets":[{"upTo":49999,"tax":0},{"upTo":1000000,"tax":200},{"upTo":2000000,"tax":400},{"upTo":3000000,"tax":600},{"upTo":5000000,"tax":1000},{"upTo":10000000,"tax":2000},{"upTo":20000000,"tax":4000},{"upTo":30000000,"tax":6000},{"upTo":50000000,"tax":10000},{"upTo":100000000,"tax":20000},{"upTo":200000000,"tax":40000},{"upTo":300000000,"tax":60000},{"upTo":500000000,"tax":100000},{"upTo":1000000000,"tax":150000},{"upTo":null,"tax":200000}]}'::jsonb),
  ('capital_gains', DATE '2013-01-01', DATE '2037-12-31', '{"long":{"incomeTaxBp":1500,"residentTaxBp":500},"short":{"incomeTaxBp":3000,"residentTaxBp":900},"reconstructionBp":210,"longTermYears":5,"residentialDeduction":30000000,"unknownCostRateBp":500}'::jsonb)
) AS v(kind, valid_from, valid_to, content);

-- 権限 deal(取引)を3テンプレートへ付与(設計 §2.6: 全員が閲覧・編集)。
-- fresh DB ではテンプレート未作成のため 0 行になり、seed が同じ行を作る。
INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'deal', 'read', true
FROM "permission_templates" pt
WHERE pt."name" IN ('管理者用', '事務担当用', '現地担当用')
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;

INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'deal', 'write', true
FROM "permission_templates" pt
WHERE pt."name" IN ('管理者用', '事務担当用', '現地担当用')
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;
