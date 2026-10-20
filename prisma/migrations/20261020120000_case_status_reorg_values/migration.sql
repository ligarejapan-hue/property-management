-- 案件ステータスの整理(2026-10-20): 契約予定・契約完了を足す。
-- 並べ替えが「販売中 → 契約予定 → 契約完了 → 決済完了(sold)」の順になるよう、販売中の後ろに入れる。
-- 値の移し替え(UPDATE)は次の migration に分ける(足した値を同じ流れの中では使えないため)。
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'contract_planned' AFTER 'on_sale';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'contracted' AFTER 'contract_planned';

-- 変更履歴の「どこから」に「自動」を足す(案件ステータスの自動の切り替え)。
ALTER TYPE "ChangeSource" ADD VALUE IF NOT EXISTS 'auto';
