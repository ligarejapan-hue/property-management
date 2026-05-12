-- Add introduction_route column to properties table.
ALTER TABLE "properties" ADD COLUMN "introduction_route" TEXT;
CREATE INDEX "properties_introduction_route_idx" ON "properties"("introduction_route");
