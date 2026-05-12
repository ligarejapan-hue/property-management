-- AlterEnum: add 11 new values to CaseStatus (ADD VALUE is non-transactional in PostgreSQL)
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'contacting_owner';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'owner_contacted';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'confirming_owner';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'response_received';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'appraisal';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'negotiating';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'brokerage_obtained';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'on_sale';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'other_brokerage';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'sold';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'closed';
