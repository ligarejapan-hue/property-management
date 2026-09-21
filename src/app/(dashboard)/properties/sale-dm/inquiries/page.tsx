"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import SaleDmInquiryList from "@/components/sale-dm/inquiry-list";

// 「査定の申込」画面(発注者判断 2026-09-18): キャンペーン作成者に限らず、売却DMを使える人は
// 誰でも見て対応できる横断一覧。通知メールの本文からは `?focus=<inquiryId>` 付きで飛んで来る
// (該当行を強調・スクロール)。認可そのものはサーバーの横断API(requireSaleDmAccess)が持つので、
// この画面自体は sidebar の minRole(office_staff)だけで出し分ける(権限が無ければ API が 403 を返す)。
// Next.js 16 では useSearchParams を使うクライアントコンポーネントを Suspense で包む必要がある。
export default function SaleDmInquiriesPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-500 dark:text-gray-400">読み込み中...</div>}>
      <SaleDmInquiriesPageInner />
    </Suspense>
  );
}

function SaleDmInquiriesPageInner() {
  const searchParams = useSearchParams();
  const focusId = searchParams.get("focus");

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="査定の申込"
        description="公開LPから届いた査定のお申込みです。売却DMを使える人は誰でも対応できます。"
      />
      <SaleDmInquiryList mode="all" focusId={focusId} />
    </div>
  );
}
