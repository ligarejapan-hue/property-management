-- 丁目と小字が併存する町字(地方部に実在)で「大字+小字+丁目」の並びが崩れる問題の
-- 是正(additive)。小字を独立列で持ち、表示は 大字→丁目→小字 の正順で組み立てる。
-- 既存行は小字なし('')として扱う=挙動不変。
ALTER TABLE "address_residence_points" ADD COLUMN "koaza" TEXT NOT NULL DEFAULT '';
