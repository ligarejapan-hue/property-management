-- 金融機関・支店の名簿(2026-11-17 発注者「銀行名・支店名は金融機関のデータを保管して、一文字目で検索」)。
-- 表を2つ足すだけ(今ある表・行は触らない)。中身は scripts/import-bank-directory.ts で入れる(migration では入れない)。
-- 戻すとき: この2つの表を DROP するだけ(取引の口座は名前の文字で持っているので影響しない)。

-- CreateTable
CREATE TABLE "bank_institutions" (
    "code" CHAR(4) NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT NOT NULL,
    "kana" TEXT NOT NULL,
    "roma" TEXT NOT NULL,
    "source_version" TEXT NOT NULL,

    CONSTRAINT "bank_institutions_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "bank_branches" (
    "bank_code" CHAR(4) NOT NULL,
    "code" CHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT NOT NULL,
    "kana" TEXT NOT NULL,
    "roma" TEXT NOT NULL,

    CONSTRAINT "bank_branches_pkey" PRIMARY KEY ("bank_code","code")
);

-- AddForeignKey
ALTER TABLE "bank_branches" ADD CONSTRAINT "bank_branches_bank_code_fkey" FOREIGN KEY ("bank_code") REFERENCES "bank_institutions"("code") ON DELETE CASCADE ON UPDATE CASCADE;
