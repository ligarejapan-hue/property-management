-- 謄本の名義とシステムの所有者を比べた結果(2026-11-08 発注者依頼・表を足すだけ)。
-- ⚠氏名・住所は保存しない(結果と「このままでよい」の判断だけ)。
--
-- 比べたあとに所有者や謄本が変わったら、**DB のトリガー**で stale(比べ直しが要る)を立てる。
-- 所有者を付け外しする経路は多い(取込・貼り付け・付け替え・外す・別の物件にする…)ので、
-- アプリの経路ごとに付けると付け忘れが出る。トリガーは既にある行を更新するだけで、行は作らない。
--   - property_owners の追加・削除・付け替え
--   - owners の氏名の変更
--   - attachments の謄本(type=registry)の追加・削除/復元・種別の変更・付け先の変更
--
-- 戻し方: アプリだけを前の版に戻せばよい(前の版はこの表を読まない)。表とトリガーは残してよい。
-- 消す場合は DROP TRIGGER ×3 → DROP FUNCTION ×3 → DROP TABLE "registry_owner_checks" の順。

-- CreateTable
CREATE TABLE "registry_owner_checks" (
    "property_id" UUID NOT NULL,
    "attachment_id" UUID,
    "result" TEXT NOT NULL,
    "decision" TEXT,
    "decided_by" UUID,
    "decided_at" TIMESTAMP(3),
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registry_owner_checks_pkey" PRIMARY KEY ("property_id")
);

ALTER TABLE "registry_owner_checks" ADD CONSTRAINT "registry_owner_checks_result_values"
  CHECK ("result" IN ('same', 'same_notation', 'mismatch', 'unreadable', 'no_owner'));
ALTER TABLE "registry_owner_checks" ADD CONSTRAINT "registry_owner_checks_decision_values"
  CHECK ("decision" IS NULL OR "decision" = 'keep');

-- CreateIndex
CREATE INDEX "registry_owner_checks_result_stale_idx" ON "registry_owner_checks"("result", "stale");

-- AddForeignKey
ALTER TABLE "registry_owner_checks" ADD CONSTRAINT "registry_owner_checks_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registry_owner_checks" ADD CONSTRAINT "registry_owner_checks_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 所有者の付け外し・付け替え
CREATE FUNCTION "registry_owner_checks_stale_from_links"() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE "registry_owner_checks" SET "stale" = true
      WHERE "property_id" = NEW."property_id" AND NOT "stale";
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    UPDATE "registry_owner_checks" SET "stale" = true
      WHERE "property_id" = OLD."property_id" AND NOT "stale";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "registry_owner_checks_stale_from_links"
  AFTER INSERT OR DELETE OR UPDATE OF "property_id", "owner_id" ON "property_owners"
  FOR EACH ROW EXECUTE FUNCTION "registry_owner_checks_stale_from_links"();

-- 所有者の氏名の変更(その人がつながっている物件すべて)
CREATE FUNCTION "registry_owner_checks_stale_from_owner_name"() RETURNS trigger AS $$
BEGIN
  UPDATE "registry_owner_checks" c SET "stale" = true
    FROM "property_owners" po
    WHERE po."owner_id" = NEW."id" AND c."property_id" = po."property_id" AND NOT c."stale";
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "registry_owner_checks_stale_from_owner_name"
  AFTER UPDATE OF "name" ON "owners"
  FOR EACH ROW WHEN (OLD."name" IS DISTINCT FROM NEW."name")
  EXECUTE FUNCTION "registry_owner_checks_stale_from_owner_name"();

-- 謄本の添付の変化
CREATE FUNCTION "registry_owner_checks_stale_from_registry"() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."type" = 'registry' AND NEW."property_id" IS NOT NULL THEN
    UPDATE "registry_owner_checks" SET "stale" = true
      WHERE "property_id" = NEW."property_id" AND NOT "stale";
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') AND OLD."type" = 'registry' AND OLD."property_id" IS NOT NULL THEN
    UPDATE "registry_owner_checks" SET "stale" = true
      WHERE "property_id" = OLD."property_id" AND NOT "stale";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "registry_owner_checks_stale_from_registry"
  AFTER INSERT OR DELETE OR UPDATE OF "type", "is_deleted", "registry_certificate_type", "property_id" ON "attachments"
  FOR EACH ROW EXECUTE FUNCTION "registry_owner_checks_stale_from_registry"();
