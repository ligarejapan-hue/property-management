"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

interface HelpSection {
  title: string;
  description: string;
}

const helpSections: HelpSection[] = [
  {
    title: "システム概要",
    description:
      "本システムは不動産物件の管理、所有者情報の確認、ダイレクトメール（DM）送付判断の支援を行うための業務システムです。物件情報の登録・検索・更新、登記情報の取得状況管理、担当者のアサインなどを一元的に管理できます。",
  },
  {
    title: "現地登録の使い方",
    description:
      "現地調査時に物件情報を登録する際は、物件一覧画面から「新規登録」ボタンを押し、住所・地番・種別などの基本情報を入力してください。写真の添付や位置情報の記録も可能です。（Phase 2以降で実装予定）",
  },
  {
    title: "候補確認について",
    description:
      "DM送付候補となる物件は、登記情報の取得状況と調査結果に基づいて自動的に候補リストに追加されます。候補一覧画面で確認・承認を行い、送付可否の最終判断を記録してください。",
  },
  {
    title: "ステータス一覧",
    description:
      "物件には以下のステータスがあります。「登記状況」: 取得済 / 未取得 / 取得中。「DM判断」: 送付可 / 送付不可 / 未判断。「案件ステータス」: 新規 / 対応中 / 完了 / 保留。各ステータスは担当者が手動で更新するか、システム連携により自動更新されます。",
  },
  {
    title: "所有者情報の見方",
    description:
      "所有者情報は権限レベルに応じて表示が制御されます。「全表示」: すべての情報がそのまま表示されます。「マスク表示」: 一部の文字が伏せ字になります。「部分表示」: 都道府県・市区町村レベルまでの情報のみ表示されます。「非表示」: 権限がないため表示されません。詳細は管理者にお問い合わせください。",
  },
  {
    title: "CSV出力ルール",
    description:
      "CSV出力は物件一覧画面の「エクスポート」ボタンから実行できます。出力されるデータは、ログインユーザーの権限レベルに応じてフィルタリングされます。個人情報を含むフィールドは権限に基づいてマスク処理されます。（Phase 2以降で実装予定）",
  },
  {
    title: "取込手順",
    description:
      "外部データの取り込みは、CSV形式のファイルをアップロードすることで実施します。テンプレートファイルをダウンロードし、必要なデータを入力の上アップロードしてください。重複データの検出と既存データとのマージ処理が自動的に行われます。（Phase 2以降で実装予定）",
  },
  {
    title: "権限とセキュリティ",
    description:
      "本システムでは4つの権限レベル（管理者・マネージャー・オペレーター・閲覧者）を設定できます。各権限レベルに応じて、閲覧可能な情報や実行可能な操作が異なります。管理者は「ユーザー管理」画面から権限の割り当てや変更を行えます。すべての操作は監査ログに記録されます。",
  },
  {
    title: "よくある質問 (FAQ)",
    description:
      "Q: パスワードを忘れた場合は？ → 管理者に連絡してリセットを依頼してください。Q: 物件情報が表示されない場合は？ → 検索フィルターをリセットするか、アクセス権限を確認してください。Q: エラーが発生した場合は？ → 画面のスクリーンショットとともに管理者に報告してください。",
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
    <div className="border-b border-gray-200 last:border-b-0">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-gray-50"
      >
        <span className="text-sm font-medium text-gray-800">
          {section.title}
        </span>
        {isOpen ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-gray-500" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-gray-500" />
        )}
      </button>
      {isOpen && (
        <div className="px-5 pb-4">
          <p className="text-sm leading-relaxed text-gray-600">
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
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800">ヘルプ</h2>
        <p className="mt-1 text-sm text-gray-500">
          システムの使い方や各機能の説明をご覧いただけます。
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white">
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
