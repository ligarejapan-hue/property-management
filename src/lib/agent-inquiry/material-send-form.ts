import { isSingleAddress } from "./material-send";

export interface MaterialFormFile {
  id: string;
  fileSize: number;
  warning: string | null;
}

/**
 * サーバーが「送っていない」とはっきり返したコード。これ以外(通信切れ・中継の時間切れ・500 など)は
 * 送れていることがある=鍵を替えずに押し直してもらう(同じ鍵なら2通目は出ない・最終レビュー I1)。
 */
const DEFINITELY_NOT_SENT: ReadonlySet<string> = new Set([
  "SEND_FAILED",
  "NOT_SELECTABLE",
  "TOO_LARGE",
  "NO_FILES",
  "TOO_MANY",
  "INVALID_ADDRESS",
  "MAIL_NOT_CONFIGURED",
  "FILE_UNAVAILABLE",
  "NOT_MATERIAL_REQUEST",
  "VALIDATION_ERROR",
  "FORBIDDEN",
  "NOT_FOUND",
  "CLIENT_TOKEN_MISMATCH",
]);

export function afterSendError(code: string | null): { renewToken: boolean; unknown: boolean } {
  const definite = code != null && DEFINITELY_NOT_SENT.has(code);
  return { renewToken: definite, unknown: !definite };
}

/** 送信の応答(押し直しで前の結果が返ったときも含む)をどう扱うか。 */
export function afterSendResponse(r: { result: string; state?: string }): {
  kind: "sent" | "failed" | "pending" | "unknown";
  renewToken: boolean;
} {
  if (r.result === "sent") return { kind: "sent", renewToken: false };
  if (r.result === "failed") return { kind: "failed", renewToken: true };
  // 送信中のまま10分を過ぎた(途中で止まった)=結果不明。送り直せるよう鍵を替える(最終レビュー I3)。
  if (r.state === "結果不明") return { kind: "unknown", renewToken: true };
  return { kind: "pending", renewToken: false };
}

/** 資料を送る小窓の状態(選んだ合計・上限・注意・送信できるか)。画面の出し分けはここだけで決める。 */
export function materialFormState(s: {
  files: MaterialFormFile[];
  picked: string[];
  to: string;
  subject: string;
  body: string;
  mailConfigured: boolean;
  maxTotalBytes: number;
  maxFiles: number;
  busy: boolean;
}) {
  const chosen = s.files.filter((f) => s.picked.includes(f.id));
  const total = chosen.reduce((sum, f) => sum + f.fileSize, 0);
  const tooLarge = total > s.maxTotalBytes;
  const tooMany = chosen.length > s.maxFiles;
  const warnings = [...new Set(chosen.map((f) => f.warning).filter((w): w is string => !!w))];
  const canSend =
    s.mailConfigured &&
    chosen.length > 0 &&
    !tooLarge &&
    !tooMany &&
    isSingleAddress(s.to.trim()) &&
    s.subject.trim() !== "" &&
    s.body.trim() !== "" &&
    !s.busy;
  return { chosenCount: chosen.length, total, tooLarge, tooMany, warnings, canSend };
}
