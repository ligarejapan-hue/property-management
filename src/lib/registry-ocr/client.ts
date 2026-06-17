/**
 * Registry OCR client（server-only・gated・fail-closed）。
 *
 *  - REGISTRY_OCR_URL が未設定 / localhost allowlist 外なら「未設定扱い」。
 *  - 本番デフォルトは無効（env 未設定）＝現行挙動を完全維持。
 *  - 送信先は localhost のみ（PII egress 防止）。timeout / size 上限 / redirect 拒否 /
 *    response schema 検証。失敗は throw（呼び出し側で手動貼付 fallback）。
 *  - raw OCR text・PDF 本文はログに出さない（PII）。
 */
import { parseLocalhostOcrUrl } from "./url-allowlist";
import { ocrResponseSchema, type OcrResponse } from "./types";

// 既存アップロード上限（storage MAX_FILE_SIZE）と同値。
export const MAX_PDF_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export class RegistryOcrError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "RegistryOcrError";
  }
}

function resolveTimeoutMs(): number {
  const raw = process.env.REGISTRY_OCR_TIMEOUT_MS;
  const n = raw != null && raw !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/** OCR が利用可能か（env 設定済 かつ localhost allowlist 通過）。 */
export function isRegistryOcrConfigured(): boolean {
  return parseLocalhostOcrUrl(process.env.REGISTRY_OCR_URL) !== null;
}

/**
 * ローカル OCR サービスへ PDF を送り抽出テキストを得る。
 * fetchFn は test 用に注入可能（既定は global fetch）。
 */
export async function requestOcrText(
  pdfBytes: Uint8Array,
  fetchFn: typeof fetch = fetch,
): Promise<OcrResponse> {
  const url = parseLocalhostOcrUrl(process.env.REGISTRY_OCR_URL);
  if (!url) {
    throw new RegistryOcrError("NOT_CONFIGURED", "OCR サービスは未設定です");
  }
  if (pdfBytes.byteLength > MAX_PDF_BYTES) {
    throw new RegistryOcrError("TOO_LARGE", "OCR 対象 PDF が上限を超えています");
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([pdfBytes as BlobPart], { type: "application/pdf" }),
    "registry.pdf",
  );

  let res: Response;
  try {
    res = await fetchFn(url.toString(), {
      method: "POST",
      body: form,
      redirect: "error", // 外部 redirect を拒否（SSRF/egress 防止）
      signal: AbortSignal.timeout(resolveTimeoutMs()),
    });
  } catch (e) {
    const name = (e as { name?: string } | undefined)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new RegistryOcrError("TIMEOUT", "OCR がタイムアウトしました");
    }
    throw new RegistryOcrError("NETWORK", "OCR への接続に失敗しました");
  }

  if (!res.ok) {
    throw new RegistryOcrError(
      "UPSTREAM",
      `OCR サービスがエラーを返しました (status ${res.status})`,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new RegistryOcrError("BAD_RESPONSE", "OCR レスポンスを解釈できません");
  }
  const parsed = ocrResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new RegistryOcrError("BAD_RESPONSE", "OCR レスポンス形式が不正です");
  }
  return parsed.data;
}
