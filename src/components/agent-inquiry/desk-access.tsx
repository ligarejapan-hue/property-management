"use client";

import { createContext, useContext } from "react";
import { apiErrorCode } from "@/lib/api-client";

/**
 * 受付の窓の 401/403 の扱いを1か所にまとめる(@codex #459 R18〜R20)。窓は開きっぱなしで使うので、
 * どの呼び出しで断られても同じように、ログイン切れ・権限なしの画面へ切り替える。
 */
export type DeskAccess = {
  /** 読み込みが断られた。401=ログイン切れ・403=権限なしとして画面ごと隠したら true。 */
  readDenied: (e: unknown) => boolean;
  /** 書き込みが断られた。401=ログイン切れで画面ごと隠したら true。403 は権限を読み直す(書けない表示へ)=false。 */
  writeDenied: (e: unknown) => boolean;
};

export function makeDeskAccess(h: {
  sessionLost: () => void;
  readForbidden: () => void;
  writeForbidden: () => void;
}): DeskAccess {
  return {
    readDenied: (e) => {
      const code = apiErrorCode(e);
      if (code === "UNAUTHORIZED") {
        h.sessionLost();
        return true;
      }
      if (code === "FORBIDDEN") {
        h.readForbidden();
        return true;
      }
      return false;
    },
    writeDenied: (e) => {
      const code = apiErrorCode(e);
      if (code === "UNAUTHORIZED") {
        h.sessionLost();
        return true;
      }
      // 書く権限だけ外された=読むことはできる。権限を読み直して登録・変更の欄を引っ込める(文言は各自で出す)。
      if (code === "FORBIDDEN") h.writeForbidden();
      return false;
    },
  };
}

// 窓の外(テスト等)では何もしない。
const NONE: DeskAccess = { readDenied: () => false, writeDenied: () => false };
export const DeskAccessContext = createContext<DeskAccess>(NONE);
export const useDeskAccess = () => useContext(DeskAccessContext);
