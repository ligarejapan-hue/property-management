import { redirect } from "next/navigation";

// 所有者CSVの取り込みは、受付帳の取込画面(/import)の中の
// 「② 受付帳 × 所有者 2ファイル突合」セクションで行う。
// ⚠素の /import へ送ると**上から入ってしまい**、その作業が画面のどこにあるか
//   分からない(@codex #411 R1 P2)。該当セクションの位置まで送る。
//   ⚠この画面自体は残す=すでに配られている URL やブックマークを切らないため。
export default function OwnerImportPage() {
  redirect("/import#owner-match");
}
