"use client";

import { useState, type ReactNode } from "react";
import RoleLink from "@/components/ui/role-link";
import { PageHeader } from "@/components/ui/page-header";
import { ChevronDown, ChevronRight } from "lucide-react";

interface HelpSection {
  title: string;
  description: ReactNode;
}

const helpSections: HelpSection[] = [
  {
    title: "システム概要",
    description:
      "本システムは不動産物件の管理、所有者情報の確認、ダイレクトメール（DM）送付判断の支援を行うための業務システムです。物件情報の登録・検索・更新、登記情報の取得状況管理、担当者のアサインなどを一元的に管理できます。",
  },
  {
    title: "現地登録の使い方",
    description: (
      <>現地では<RoleLink href="/field-survey/map" minRole="field_staff">「現地調査マップ」画面</RoleLink>の「撮って登録」で、写真と位置をその場で記録します。記録した候補は<RoleLink href="/field-survey/candidates" minRole="field_staff">「物件化の完成待ち」画面</RoleLink>に並び、足りない項目を埋めると物件になります。事務所で登録するときは<RoleLink href="/properties" minRole="office_staff">物件一覧画面</RoleLink>の「新規物件登録」から、住所・地番・種別などを入力します。</>
    ),
  },
  {
    title: "ステータス一覧",
    description:
      "物件には以下のステータスがあります。「登記状況」: 取得済 / 未取得 / 取得中。「DM判断」: 送付可 / 送付不可 / 未判断。「案件ステータス」: 未着手 / 所有者とやりとり中 / 査定中 / 商談中 / 媒介取得 / 販売中 / 契約予定 / 契約完了 / 決済完了 / 他社で決まった / 保留 / 見送り・終了。各ステータスは担当者が手動で更新します。案件ステータスは、所有者から手紙のQRで申込が届くと「所有者とやりとり中」に、査定報告書を物件に付けると「査定中」に自動で進みます（前に進むときだけ・保留や見送りの物件は動かしません）。",
  },
  {
    title: "所有者情報の見方",
    description:
      "所有者情報は権限レベルに応じて表示が制御されます。「全表示」: すべての情報がそのまま表示されます。「マスク表示」: 一部の文字が伏せ字になります。「部分表示」: 都道府県・市区町村レベルまでの情報のみ表示されます。「非表示」: 権限がないため表示されません。詳細は管理者にお問い合わせください。",
  },
  {
    title: "CSV出力ルール",
    description: (
      <>CSV出力は<RoleLink href="/properties" minRole="office_staff">物件一覧画面</RoleLink>の「CSV出力」ボタンから、出力する列を選んで実行します。出力されるデータは、ログインユーザーの権限に応じて絞り込まれ、個人情報を含む項目は権限に応じて伏せられます。</>
    ),
  },
  {
    title: "取込手順",
    description: (
      <>外部の一覧や書類からまとめて登録するときは、左のメニューの「物件データ取り込み」を使います。受付帳のCSVは<RoleLink href="/import" minRole="office_staff">「受付帳CSV取込」画面</RoleLink>、謄本のPDFは<RoleLink href="/import/registry-pdf" minRole="office_staff">「謄本PDF取込」画面</RoleLink>から取り込みます。<RoleLink href="/import/paste" minRole="office_staff">「貼り付けて物件化」画面</RoleLink>では、メールやPDF、コピーしたウェブページの文章をそのまま貼り付けるだけで、読み取れた項目を自動で入力欄に埋めてくれます。登録前に内容を確認できます。</>
    ),
  },
  {
    title: "権限とセキュリティ",
    description: (
      <>利用者の役割は「管理者」「事務担当」「現地担当」の3つで、右上に自分の役割が表示されます。役割に加えて、利用者ごとの権限（どの情報を見られるか・編集できるか）で、見える情報やできる操作が決まります。管理者は<RoleLink href="/admin/users" minRole="admin">「ユーザー管理」画面</RoleLink>から役割や権限の割り当て・変更を行えます。主な操作は<RoleLink href="/admin/audit-logs" minRole="admin">「監査ログ」画面</RoleLink>に記録されます。</>
    ),
  },
  {
    title: "よくある質問 (FAQ)",
    description: (
      <>Q: パスワードを変えたい場合は？ → 右上の鍵のボタンから<RoleLink href="/admin/change-password" minRole="field_staff">「パスワード変更」画面</RoleLink>を開いて変更できます。Q: パスワードを忘れた場合は？ → 管理者に連絡してリセットを依頼してください。Q: 物件情報が表示されない場合は？ → 検索フィルターをリセットするか、アクセス権限を確認してください。Q: エラーが発生した場合は？ → 画面のスクリーンショットとともに管理者に報告してください。</>
    ),
  },
];

function AccordionItem({
  section,
  isOpen,
  onToggle,
}: {
  section: HelpSection;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-b border-gray-200 last:border-b-0 dark:border-gray-800">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
          {section.title}
        </span>
        {isOpen ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
        )}
      </button>
      {isOpen && (
        <div className="px-5 pb-4">
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">
            {section.description}
          </p>
        </div>
      )}
    </div>
  );
}

export default function HelpPage() {
  const [openSections, setOpenSections] = useState<Set<number>>(
    new Set([0])
  );

  const toggle = (index: number) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  return (
    <div>
      <PageHeader
        title="ヘルプ"
        description="システムの使い方や各機能の説明をご覧いただけます。"
      />

      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        {helpSections.map((section, index) => (
          <AccordionItem
            key={index}
            section={section}
            isOpen={openSections.has(index)}
            onToggle={() => toggle(index)}
          />
        ))}
      </div>
    </div>
  );
}
