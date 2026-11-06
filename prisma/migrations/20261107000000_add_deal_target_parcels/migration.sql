-- この取引の土地・建物(列を足すだけ・今ある取引は空=全部のまま)。
ALTER TABLE "deals" ADD COLUMN "target_parcels" JSONB;
