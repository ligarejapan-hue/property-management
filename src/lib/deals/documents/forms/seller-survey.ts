import type { FormChoice, FormDef } from "./types";

/**
 * 売主属性調査書(社内用)の項目の表(設計 第2段階 §4.2)。
 * 項目は以前の Excel を参考に、文面はこちらで起案。前の会社の書式にあった取引先の台帳・買い戻しの項目は入れない。
 */
const YN: FormChoice[] = [{ value: "no", label: "無" }, { value: "yes", label: "有" }];
const DONE: FormChoice[] = [{ value: "done", label: "済" }, { value: "notYet", label: "未" }];
const CAN: FormChoice[] = [{ value: "can", label: "できる" }, { value: "cannot", label: "できない" }];

export const SELLER_SURVEY_FORM: FormDef = {
  key: "seller_survey",
  entries: [
    { kind: "section", title: "1. 売主のこと" },
    { kind: "item", key: "sellerType", label: "個人・法人", choices: [{ value: "individual", label: "個人" }, { value: "corporation", label: "法人" }] },
    { kind: "item", key: "coOwners", label: "共有者", choices: YN },
    { kind: "item", key: "sameAsRegistry", label: "登記名義人と売主", choices: [{ value: "same", label: "同じ" }, { value: "different", label: "違う" }] },
    {
      kind: "item", key: "differentReason", label: "違うときの理由", multiple: true,
      choices: [{ value: "changeNotRegistered", label: "住所・氏名の変更登記がまだ" }, { value: "inheritanceNotRegistered", label: "相続登記がまだ" }, { value: "other", label: "その他" }],
      fields: [{ key: "differentReasonOther", label: "内容", max: 200 }],
    },
    {
      kind: "item", key: "linkDocs", label: "つながりを示す書類", multiple: true,
      choices: [{ value: "residentCard", label: "住民票" }, { value: "familyRegister", label: "戸籍" }, { value: "divisionAgreement", label: "遺産分割協議書" }, { value: "other", label: "その他" }],
      fields: [{ key: "linkDocsOther", label: "その他の書類", max: 200 }],
    },
    { kind: "item", key: "capacity", label: "破産・成年後見・入院など、本人の意思確認が要る事情", choices: YN, fields: [{ key: "capacityDetail", label: "内容", max: 200 }] },
    { kind: "item", key: "byAgent", label: "代理人による契約(委任状)", choices: YN, fields: [{ key: "agentName", label: "代理人", max: 100 }] },
    {
      kind: "item", key: "nonResident", label: "非居住者", choices: [{ value: "no", label: "該当しない" }, { value: "yes", label: "該当する" }],
      note: { when: "yes", text: "売主が非居住者のときは、買主が代金を支払うときに源泉徴収をする必要があります(所得税法)。" },
    },
    { kind: "section", title: "2. 確認したこと" },
    { kind: "item", key: "idCheck", label: "本人確認書類の確認", choices: DONE, fields: [{ key: "idCheckDocs", label: "確認した書類", max: 200 }] },
    {
      kind: "item", key: "antisocialCheck", label: "反社会的勢力でないことの確認", choices: DONE,
      fields: [{ key: "antisocialBy", label: "確認した人", max: 100 }, { key: "antisocialOn", label: "確認した日", max: 50 }],
    },
    { kind: "section", title: "3. 売却の経緯" },
    {
      kind: "item", key: "acquiredBy", label: "取得の原因",
      choices: [{ value: "purchase", label: "売買" }, { value: "inheritance", label: "相続" }, { value: "gift", label: "贈与" }, { value: "auction", label: "競売" }, { value: "other", label: "その他" }],
      fields: [{ key: "acquiredWhen", label: "時期", max: 50 }, { key: "acquiredOther", label: "その他の内容", max: 200 }],
    },
    {
      kind: "item", key: "saleReason", label: "売却の理由",
      choices: [{ value: "replace", label: "買い替え" }, { value: "relocate", label: "住み替え" }, { value: "inheritanceCash", label: "相続による換金" }, { value: "assetCleanup", label: "資産整理" }, { value: "other", label: "その他" }],
      fields: [{ key: "saleReasonOther", label: "その他の内容", max: 200 }],
    },
    { kind: "item", key: "objection", label: "第三者からの異議", choices: YN, fields: [{ key: "objectionDetail", label: "内容", max: 200 }] },
    { kind: "section", title: "4. 物件のこと" },
    {
      kind: "item", key: "usage", label: "今の使い方",
      choices: [
        { value: "self", label: "自分で住んでいる" }, { value: "family", label: "家族が住んでいる" }, { value: "rented", label: "賃貸中" },
        { value: "office", label: "事務所や店舗" }, { value: "vacant", label: "空室" }, { value: "other", label: "その他" },
      ],
      fields: [{ key: "usageOther", label: "その他の内容", max: 200 }],
    },
    {
      kind: "item", key: "incidents", label: "これまでの出来事", multiple: true,
      choices: [{ value: "fire", label: "火災" }, { value: "leak", label: "漏水" }, { value: "accident", label: "事件や事故" }, { value: "neighborTrouble", label: "近隣とのトラブル" }, { value: "none", label: "特になし" }],
      fields: [{ key: "incidentsDetail", label: "内容", max: 300 }],
    },
    { kind: "item", key: "feeArrears", label: "管理費等の滞納", choices: YN },
    { kind: "item", key: "feeArrearsSettle", label: "管理費等の滞納を決済で精算できるか", choices: CAN },
    { kind: "item", key: "taxArrears", label: "税の滞納", choices: YN },
    { kind: "item", key: "taxArrearsSettle", label: "税の滞納を決済で精算できるか", choices: CAN },
    { kind: "item", key: "seizure", label: "差押え・仮登記", choices: YN, fields: [{ key: "seizureParty", label: "相手の種類", max: 100 }] },
    { kind: "item", key: "mortgage", label: "抵当権など", choices: YN, fields: [{ key: "mortgageParty", label: "相手の種類", max: 100 }] },
    {
      kind: "item", key: "payoff", label: "売買代金で借入れを返しきれるか",
      choices: [{ value: "can", label: "返せる" }, { value: "cannot", label: "返せない" }, { value: "noLoan", label: "借入れなし" }],
    },
    { kind: "item", key: "neighborAgreement", label: "近隣との取り決め", choices: YN, fields: [{ key: "neighborAgreementDetail", label: "内容", max: 200 }] },
    { kind: "section", title: "5. 注意事項" },
    { kind: "item", key: "remarks", label: "注意事項", fields: [{ key: "remarksText", label: "内容", max: 1000, lines: 4 }] },
  ],
};
