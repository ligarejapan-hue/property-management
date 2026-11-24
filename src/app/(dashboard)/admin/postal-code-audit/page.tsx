import { redirect } from "next/navigation";

// 2026-11-24 発注者「わざわざ分けず可能な限りページ数を減らして」: この点検は
// 「所有者の直し」の点検タブへ移した。古いアドレス(ブックマーク・資料のリンク)はそこへ飛ばす。
export default function Page() {
  redirect("/admin/owners/correction?tab=postal_code");
}
