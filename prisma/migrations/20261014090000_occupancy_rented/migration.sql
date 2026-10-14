-- 物件の現況に「賃貸中」を追加(2026-10-14 発注者指示)。追加のみ。
-- 既存の occupied は表示名を「入居中」→「居住中」に変える(値はそのまま=データの書き換えなし)。
ALTER TYPE "OccupancyStatus" ADD VALUE IF NOT EXISTS 'rented';
