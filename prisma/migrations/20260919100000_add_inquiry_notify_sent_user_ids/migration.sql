-- 通知メールに成功した宛先の user id を追記していく列(P2修正: 手動の再送ボタン/サーバー
-- 再起動後の再開で同じ宛先へ二重送信しないための唯一の正本)。user id のみ=個人情報を含まない。
ALTER TABLE "dm_inquiries" ADD COLUMN "notify_sent_user_ids" UUID[] NOT NULL DEFAULT '{}';
