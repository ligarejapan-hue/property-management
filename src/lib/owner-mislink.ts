/**
 * Phase 2-C: PropertyOwner 誤紐づき修正の safety check と型定義。
 *
 * 2 つの操作モード:
 *   - "remove": 物件から current owner を外す（PropertyOwner 行を削除）
 *   - "relink": 物件の current owner を target owner に付け替える
 *
 * 設計方針:
 *   - 純関数で副作用なし
 *   - 違反は全件返す
 *   - PII を引数に持たない（id / 件数 / boolean のみ）
 *   - source (current) owner が archived でも remove / relink の source としては許可
 *     （誤って archived 化された owner の救済を妨げない）
 *   - target owner が archived の場合は blocker（archived owner を新たに紐付けない）
 *   - relink で target_already_linked は blocker（自動 remove に切替えない）
 *   - OwnerMemo は触らない（preview で件数提示のみ）
 *   - ImportJobRow.createdId は書き換えない
 */

export type OwnerMislinkOperation = "remove" | "relink";

export type OwnerMislinkBlockReason =
  | "missing_operation"              // operation 未指定 / 不正
  | "missing_target_for_relink"      // operation=relink で targetOwnerId が無い
  | "same_owner_id"                  // currentOwnerId === targetOwnerId
  | "property_owner_not_found"       // PropertyOwner 行が存在しない
  | "property_owner_state_mismatch"  // PropertyOwner.propertyId が指定と一致しない
  | "current_owner_id_mismatch"      // PropertyOwner.ownerId が currentOwnerId と一致しない
  | "property_not_found"             // property 不存在
  | "property_archived"              // property が isArchived=true
  | "current_owner_not_found"        // currentOwner 不存在
  | "target_owner_not_found"         // relink 時、target 不存在
  | "target_owner_archived"          // relink 時、target が isArchived=true
  | "target_already_linked"          // relink 時、target が同 property に既に紐付き
  | "version_mismatch";              // propertyVersion / currentOwnerVersion / targetOwnerVersion 不一致

export interface OwnerMislinkSafetyInput {
  operation: OwnerMislinkOperation | null;
  // operation == "relink" で targetOwnerId が undefined / null なら missing_target_for_relink
  hasTargetForRelink: boolean;
  // currentOwnerId === targetOwnerId （文字列レベル）
  sameOwnerId: boolean;

  // PropertyOwner 行に関する判定
  propertyOwnerExists: boolean;
  propertyOwnerPropertyIdMatches: boolean;  // PropertyOwner.propertyId === propertyId
  propertyOwnerOwnerIdMatches: boolean;     // PropertyOwner.ownerId === currentOwnerId

  // property 側
  propertyExists: boolean;
  propertyIsArchived: boolean;
  propertyVersionMatches: boolean;

  // currentOwner 側
  currentOwnerExists: boolean;
  // currentOwner は archived でも source としては許可（救済経路）→ blocker にしない
  currentOwnerVersionMatches: boolean;

  // targetOwner 側（operation=relink でのみ評価）
  targetOwnerExists: boolean;
  targetOwnerIsArchived: boolean;
  targetOwnerVersionMatches: boolean;
  targetAlreadyLinked: boolean;
}

export type OwnerMislinkSafetyResult =
  | { ok: true }
  | { ok: false; reasons: OwnerMislinkBlockReason[] };

/**
 * 誤紐づき修正の安全条件チェック。複数違反は全件返す。
 *
 * 評価順序:
 *   1. operation 自体の検証
 *   2. PropertyOwner 行の存在・一致
 *   3. property / currentOwner の存在・状態
 *   4. relink 時のみ: targetOwner の存在・状態・@@unique 衝突
 *   5. version (3 種類) 各々
 */
export function checkOwnerMislinkSafety(
  input: OwnerMislinkSafetyInput,
): OwnerMislinkSafetyResult {
  const reasons: OwnerMislinkBlockReason[] = [];

  if (input.operation !== "remove" && input.operation !== "relink") {
    reasons.push("missing_operation");
  }

  if (input.operation === "relink") {
    if (!input.hasTargetForRelink) {
      reasons.push("missing_target_for_relink");
    }
    if (input.sameOwnerId) {
      reasons.push("same_owner_id");
    }
  }

  // PropertyOwner 行
  if (!input.propertyOwnerExists) {
    reasons.push("property_owner_not_found");
  } else {
    if (!input.propertyOwnerPropertyIdMatches) {
      reasons.push("property_owner_state_mismatch");
    }
    if (!input.propertyOwnerOwnerIdMatches) {
      reasons.push("current_owner_id_mismatch");
    }
  }

  // property
  if (!input.propertyExists) {
    reasons.push("property_not_found");
  } else if (input.propertyIsArchived) {
    reasons.push("property_archived");
  }

  // currentOwner
  if (!input.currentOwnerExists) {
    reasons.push("current_owner_not_found");
  }

  // targetOwner (relink のみ)
  if (input.operation === "relink" && input.hasTargetForRelink) {
    if (!input.targetOwnerExists) {
      reasons.push("target_owner_not_found");
    } else {
      if (input.targetOwnerIsArchived) {
        reasons.push("target_owner_archived");
      }
      if (input.targetAlreadyLinked) {
        reasons.push("target_already_linked");
      }
    }
  }

  // version mismatch (まとめて 1 つに集約)
  const versionMismatch =
    (input.propertyExists && !input.propertyVersionMatches) ||
    (input.currentOwnerExists && !input.currentOwnerVersionMatches) ||
    (input.operation === "relink" &&
      input.hasTargetForRelink &&
      input.targetOwnerExists &&
      !input.targetOwnerVersionMatches);
  if (versionMismatch) {
    reasons.push("version_mismatch");
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true };
}
