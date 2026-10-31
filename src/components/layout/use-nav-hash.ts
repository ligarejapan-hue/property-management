"use client";

import { useEffect, useState } from "react";

/**
 * いま見ている位置(#)。左メニューと上部ナビで共通(見た目の設定 段階3 で sidebar.tsx から切り出し)。
 * ⚠usePathname/props の currentPath は hash を含まないので自分で追う(@codex #411 R2 P2)。初期値は空=サーバー描画と一致し、
 *   読み込み後に実際の位置へ合わせる(描画のずれによる警告を出さない)。
 * ⚠`hashchange` だけでは足りない(@codex #411 R4 P2)。アプリ内のリンクは history.pushState で遷移するため、
 *   同じページ内で位置だけ変えてもこのイベントは飛ばない。押した時点の位置は戻り値の setFromHref で入れる。
 *   ここの effect は「URL を直接開く/戻る・進む」など、押下を経由しない移動の受け口。
 */
export function useNavHash(currentPath: string) {
  const [hash, setHash] = useState("");
  useEffect(() => {
    const sync = () => setHash(window.location.hash);
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [currentPath]);

  // 押した項目そのものから位置を確定する(遷移の仕組みに関係なく確実に追随できる)。
  const setFromHref = (href: string) => {
    const at = href.indexOf("#");
    setHash(at === -1 ? "" : href.slice(at));
  };
  return { hash, setFromHref };
}
