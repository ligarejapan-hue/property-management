-- 土地の現況に「更地」「古屋あり」を追加(2026-11-11 発注者指示)。値の種類を足すだけ(データの書き換えなし)。
-- 今「空室」が入っている土地を「更地」にするのは、反映の後に別のスクリプトで行う
-- (同じ migration の中では、足したばかりの値を使えないため)。
ALTER TYPE "OccupancyStatus" ADD VALUE IF NOT EXISTS 'vacant_land';
ALTER TYPE "OccupancyStatus" ADD VALUE IF NOT EXISTS 'old_house';
