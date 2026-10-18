import { isSingleAddress } from "./material-send";

export interface MaterialFormFile {
  id: string;
  fileSize: number;
  warning: string | null;
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
