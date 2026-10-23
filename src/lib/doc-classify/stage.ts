import type { DocStageCode } from "./classify";

/**
 * 添付タブで最初に開いておく段階。案件ステータスに合わせる
 * (契約予定→②契約関係・契約完了/決済完了→③決済関係・それ以外→①契約前)。
 */
export function defaultOpenStage(caseStatus: string | null | undefined): DocStageCode {
  if (caseStatus === "contract_planned") return "contract";
  if (caseStatus === "contracted" || caseStatus === "sold") return "settlement";
  return "pre_contract";
}
