-- 受付メールの「同じアドレスへ直近に送ったか」の確認は、直近24時間の申込だけを見る。
-- 申込は消さずに残す方針なので、受付日時の索引が無いと確認のたびに全件を読むことになる。
CREATE INDEX "dm_inquiries_submitted_at_idx" ON "dm_inquiries"("submitted_at");
