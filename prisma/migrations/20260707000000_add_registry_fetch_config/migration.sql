-- CreateTable
CREATE TABLE "registry_fetch_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "login_id_enc" TEXT,
    "password_enc" TEXT,
    "base_url" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "registry_fetch_config_pkey" PRIMARY KEY ("id")
);
