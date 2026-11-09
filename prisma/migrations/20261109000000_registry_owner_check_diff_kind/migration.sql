-- 謄本の名義の確認: 物件ごとの違いの種類(2026-11-09 発注者承認・列を足すだけ)。
-- ⚠入れるのは種類の記号と人数だけ(例 "kanji,corp,count:3:2")。氏名・違う字は入れない。
-- diff_rank は一覧で種類の順に並べる値(一番重い種類)。
--
-- 今ある「違う」の行は空のまま。まだ判断していない行は「まだ比べていない」に数え直し、
-- 夜の自動の比べ・画面のボタンで比べ直すと埋まる(一覧からは消えない)。
--
-- 戻し方: アプリだけを前の版に戻せばよい(前の版はこの列を読まない)。列は残してよい。
ALTER TABLE "registry_owner_checks" ADD COLUMN "diff_kind" TEXT;
ALTER TABLE "registry_owner_checks" ADD COLUMN "diff_rank" SMALLINT;
