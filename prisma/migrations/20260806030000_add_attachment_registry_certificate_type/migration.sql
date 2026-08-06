-- 謄本添付の請求種別(owner=所有者事項 / all=全部事項)。type="registry" のときだけ意味を持つ。
-- 生ファイル名は PII マスクで隠すが、種別は非PIIなので表示ラベルに使える。
-- 既存行は NULL(=種別不明・手動取込等)で、表示は従来どおり "registry.pdf" になる。additive。
ALTER TABLE "attachments" ADD COLUMN "registry_certificate_type" TEXT;
