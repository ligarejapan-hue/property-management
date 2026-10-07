-- 通知 段階3(設計書 2026-09-27-notifications-design.md §6): 次回対応に「時刻(任意)」と、知らせの版
-- (reminder_rev_at)を足す。列の追加だけ(既存行の時刻は NULL のまま=今までどおり日付だけ)。
--
-- reminder_rev_at = 担当者・予定日・時刻を変えたとき、または完了を取り消したときに進む時刻(知らせを
-- 出し直す判断に使う版・設計書 §5.2 の rev)。**DB のトリガーで更新する**(アプリだけを前の版に戻しても
-- 正しく進むように)。
--   - INSERT: アプリが付けた updated_at と同じ値(段階2の版=updated_at と一致させる)。
--   - UPDATE: 担当・予定日・時刻のどれかが変わった/完了を取り消したときだけ
--     GREATEST(新しい updated_at, 前の値 + 1ミリ秒) に進め、updated_at も同じ値にそろえる
--     (段階2の版のアプリに戻した間も、版が重ならず、戻し直したときにずれない)。それ以外は前の値のまま。
--
-- 順番(設計書 §6): 表を書き込み止めにする → 列を足す → 既存行を updated_at で埋める → トリガーを作る。
-- 表を押さえたまま1つのトランザクションで行うので、埋めてからトリガーができるまでの間に担当が変わる
-- ことはない(Prisma の migrate deploy はこのファイルをトランザクションで包まないため、明示する)。
--
-- 戻し方: アプリだけを前の版に戻し、列とトリガーは残す(前の版は列を知らないだけで動く)。
-- 列を消すと入力済みの時刻が失われるため消さない。どうしても消す場合は、先に id と scheduled_time を
-- 書き出して保存してから、DROP TRIGGER → DROP FUNCTION → 列の削除の順で行う。

BEGIN;

-- 表を押さえるのに10秒以上待つなら諦める(長く開いたトランザクションの後ろで書き込みを
-- 待たせ続けないため)。失敗したらこの中の変更はすべて取り消される(列もトリガーも残らない)。Prisma は
-- この migration を「失敗」と記録するので、時間を置いて
--   `npx prisma migrate resolve --rolled-back 20261003120000_add_next_action_time` → `npx prisma migrate deploy`
-- の順でやり直す(アプリは前の版のまま動き続ける)。
SET LOCAL lock_timeout = '10s';

LOCK TABLE "next_actions" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "next_actions" ADD COLUMN "scheduled_time" TEXT;
ALTER TABLE "next_actions" ADD COLUMN "reminder_rev_at" TIMESTAMP(3);

-- 時刻は "HH:MM"(24時間・日本時間)だけを受け付ける。
ALTER TABLE "next_actions" ADD CONSTRAINT "next_actions_scheduled_time_format"
  CHECK ("scheduled_time" IS NULL OR "scheduled_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- 既存行は updated_at で埋める(段階2の版と同じ値=反映の前後で同じ回が出直さない)。
UPDATE "next_actions" SET "reminder_rev_at" = "updated_at" WHERE "reminder_rev_at" IS NULL;

CREATE FUNCTION "next_actions_reminder_rev"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."reminder_rev_at" := NEW."updated_at";
    RETURN NEW;
  END IF;
  IF NEW."assigned_to" IS DISTINCT FROM OLD."assigned_to"
     OR NEW."scheduled_at" IS DISTINCT FROM OLD."scheduled_at"
     OR NEW."scheduled_time" IS DISTINCT FROM OLD."scheduled_time"
     OR (OLD."is_completed" AND NOT NEW."is_completed") THEN
    NEW."reminder_rev_at" := GREATEST(
      NEW."updated_at",
      COALESCE(OLD."reminder_rev_at", OLD."updated_at") + INTERVAL '1 millisecond'
    );
    NEW."updated_at" := NEW."reminder_rev_at";
  ELSE
    -- 版はトリガーだけが進める(アプリや手作業の UPDATE では変えない)。
    NEW."reminder_rev_at" := COALESCE(OLD."reminder_rev_at", OLD."updated_at");
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "next_actions_reminder_rev"
  BEFORE INSERT OR UPDATE ON "next_actions"
  FOR EACH ROW EXECUTE FUNCTION "next_actions_reminder_rev"();

COMMIT;
