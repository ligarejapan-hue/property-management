-- CreateTable
CREATE TABLE "company_profile" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "name_ja" TEXT,
    "license" TEXT,
    "tel" TEXT,
    "fax" TEXT,
    "email" TEXT,
    "hp" TEXT,
    "address" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "company_profile_pkey" PRIMARY KEY ("id")
);
