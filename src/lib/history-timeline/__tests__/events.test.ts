import { describe, expect, it } from "vitest";
import { timelineAccess } from "../access";
import {
  buildTimelineSummary, categoryOf, changeEvents, commentEvent, dealCreatedEvent, dmReactionEvent, dmSentEvent, docFileEvent,
  docLinkIssuedEvent, docLinkRevokedEvent, docReviewEvent, documentEvent, inquiryEvent, investigationEvent, materialSendEvent, mergeTimeline,
  nextActionCompletedEvent, nextActionCreatedEvent, ownerMemoEvent, requestCopyEvent, scheduleEvent, sourcesForCategory,
  viewingEvent, type ChangeContext, type TimelineEvent,
  actorOfAudit, scheduleUndoEvent,
} from "../events";

const PID = "22222222-2222-4222-8222-222222222222";
const DEAL = { id: "11111111-1111-4111-8111-111111111111", label: "取引 2026-0001" };
const at = (s: string) => new Date(s);
const author = { name: "担当A" };

const ctx = (over: Partial<ChangeContext> = {}): ChangeContext => ({
  propertyId: PID, dealsById: new Map([[DEAL.id, DEAL]]), userNames: new Map(), inquirerLevel: "full", ownerNote: "visible",
  ownerLevels: { name: "full", nameKana: "full", phone: "full", zip: "full", address: "full", note: "full", email: "full", corporateNumber: "full" }, ...over,
});
const changeRow = (over: Record<string, unknown> = {}) => ({
  id: "c1", targetTable: "properties", targetId: PID, fieldName: "caseStatus", oldValue: "new_case", newValue: "on_sale",
  source: "manual", changedAt: at("2026-11-01T01:00:00Z"), changer: { name: "担当A" }, ...over,
});

describe("出どころごとの変換", () => {
  it("コメントは投稿者と本文を出し、やり取りに入る", () => {
    const e = commentEvent({ id: "1", body: "売主から電話", createdAt: at("2026-11-01T00:00:00Z"), author, parentId: null }, PID);
    expect(e).toMatchObject({ source: "comment", category: "contact", actor: "担当A", title: "コメント", detail: "売主から電話", href: `/properties/${PID}?tab=comments` });
    expect(commentEvent({ id: "2", body: "x", createdAt: at("2026-11-01T00:00:00Z"), author, parentId: "1" }, PID).title).toBe("コメントへの返信");
  });

  it("所有者メモは一部表示のレベルなら本文を空にし、所有者の名前は出さない", () => {
    const row = { id: "1", body: "秘密の話", createdAt: at("2026-11-01T00:00:00Z"), creator: author };
    expect(ownerMemoEvent(row, "visible", PID).detail).toBe("秘密の話");
    const meta = ownerMemoEvent(row, "meta_only", PID);
    expect(meta.detail).toBeNull();
    expect(JSON.stringify(meta)).not.toContain("秘密");
  });

  it("DM の備考は表示レベルで伏せる。日付だけの記録として返す", () => {
    const row = { id: "1", sentAt: at("2026-10-01T00:00:00Z"), method: "mail", note: "山田太郎宛", sender: author };
    const full = dmSentEvent(row, "full", PID);
    expect(full).toMatchObject({ source: "dm", category: "contact", dateOnly: true, detail: "山田太郎宛" });
    expect(dmSentEvent(row, "hidden", PID).detail).toBeNull();
    expect(JSON.stringify(dmSentEvent(row, "masked", PID))).not.toContain("山田太郎");
  });

  it("DM の反響は反響の名前を出し、備考を同じレベルで伏せる", () => {
    const row = { id: "1", reactedAt: at("2026-10-02T00:00:00Z"), reactionStatus: "refused", reactionNote: "本人より拒否" };
    expect(dmReactionEvent(row, "full", PID)).toMatchObject({ source: "dm_reaction", title: "DMの反響:拒否", actor: null, detail: "本人より拒否" });
    expect(dmReactionEvent(row, "hidden", PID).detail).toBeNull();
  });

  it("反響は業者名と担当者名を出す", () => {
    const e = inquiryEvent({ id: "1", kind: "viewing", receivedAt: at("2026-10-03T00:00:00Z"), contactName: "佐藤", agent: { companyName: "ABC不動産" }, createdBy: author }, PID);
    expect(e).toMatchObject({ source: "inquiry", title: "反響を受付:内見(ABC不動産)", detail: "担当者:佐藤", actor: "担当A" });
  });

  it("内見は予定日を時刻にし、中止を題名に出す", () => {
    const row = { id: "1", scheduledAt: at("2026-10-04T01:00:00Z"), createdAt: at("2026-10-01T00:00:00Z"), viewingType: "viewing", canceledAt: null, resultNote: "好感触", attendant: author, inquiry: { agent: { companyName: "ABC不動産" } } };
    expect(viewingEvent(row, PID)).toMatchObject({ source: "viewing", at: "2026-10-04T01:00:00.000Z", detail: "好感触", actor: "担当A" });
    expect(viewingEvent({ ...row, scheduledAt: null }, PID).at).toBe("2026-10-01T00:00:00.000Z");
    expect(viewingEvent({ ...row, canceledAt: at("2026-10-02T00:00:00Z") }, PID).title).toContain("中止");
  });

  it("資料の送付は宛先も本文も出さない", () => {
    const e = materialSendEvent({ id: "1", createdAt: at("2026-10-05T00:00:00Z"), result: "sent", sentBy: author, inquiry: { agent: { companyName: "ABC不動産" } } }, PID);
    expect(e).toMatchObject({ source: "material_send", title: "資料を送付(ABC不動産)", detail: null });
    expect(materialSendEvent({ id: "2", createdAt: at("2026-10-05T00:00:00Z"), result: "failed", sentBy: author, inquiry: { agent: { companyName: "X" } } }, PID).title).toContain("失敗");
  });

  it("次にやることは登録と完了を別の行にする(完了した人は記録が無いので出さない)", () => {
    const row = { id: "1", content: "電話する", createdAt: at("2026-10-06T00:00:00Z"), completedAt: at("2026-10-07T00:00:00Z"), scheduledAt: at("2026-10-08T00:00:00Z"), creator: author };
    expect(nextActionCreatedEvent(row, PID)).toMatchObject({ source: "next_action", category: "schedule", actor: "担当A", detail: "電話する", title: "次にやることを登録(期日 2026-10-08)" });
    const done = nextActionCompletedEvent(row, PID);
    expect(done).toMatchObject({ title: "次にやることを完了", actor: null, at: "2026-10-07T00:00:00.000Z" });
    expect(done.id).not.toBe(nextActionCreatedEvent(row, PID).id);
  });

  it("調査の記録は確定や取得の名前を出す", () => {
    const e = investigationEvent({ id: "1", action: "confirmed", note: "確認済み", createdAt: at("2026-10-09T00:00:00Z"), creator: author }, PID);
    expect(e).toMatchObject({ source: "investigation", category: "change", title: "調査情報を確定", detail: "確認済み" });
  });

  it("段取りの完了は手動か自動かを出し、誰かは出さない", () => {
    const row = { id: "1", dealId: DEAL.id, label: "決済日の確定", completedAt: at("2026-10-10T00:00:00Z"), autoCompleted: true };
    expect(scheduleEvent(row, DEAL)).toMatchObject({ source: "schedule", category: "schedule", title: "段取りを完了:決済日の確定(自動)", actor: null, dealLabel: DEAL.label });
    expect(scheduleEvent({ ...row, autoCompleted: false }, DEAL).title).toBe("段取りを完了:決済日の確定");
  });

  it("書類の発行は書類名と版を出す", () => {
    const e = documentEvent({ id: "1", docType: "funding_plan", variant: "buy", version: 2, issuedAt: at("2026-10-11T00:00:00Z"), issuedBy: author }, DEAL);
    expect(e).toMatchObject({ source: "document", category: "document", actor: "担当A" });
    expect(e.title).toContain("第2版");
  });

  it("依頼文のコピーはひな形の名前だけを出す。消えたひな形でも行は残す", () => {
    const templates = [{ id: "t1", label: "司法書士へ" }];
    const row = { id: "1", createdAt: at("2026-10-12T00:00:00Z"), detail: { templateKey: "t1", itemKey: "x" }, user: author };
    expect(requestCopyEvent(row, DEAL, templates)).toMatchObject({ source: "request_copy", category: "contact", title: "依頼文をコピー:司法書士へ", detail: null });
    expect(requestCopyEvent({ ...row, detail: { templateKey: "gone" } }, DEAL, templates).title).toBe("依頼文をコピー");
  });

  it("書類の提出は売主か買主かまでで、氏名は持たない", () => {
    const row = { id: "1", createdAt: at("2026-10-13T00:00:00Z"), request: { label: "本人確認書類", link: { partyRole: "seller" } } };
    expect(docFileEvent(row, DEAL)).toMatchObject({ source: "doc_file", category: "document", title: "売主が提出:本人確認書類", actor: "お客様" });
  });

  it("差し戻しの理由は取引を編集できる人にだけ出す", () => {
    const row = { id: "1", action: "rejected", reason: "ぼやけています", createdAt: at("2026-10-14T00:00:00Z"), reviewedBy: author, request: { label: "本人確認書類" } };
    expect(docReviewEvent(row, DEAL, true)).toMatchObject({ source: "doc_review", title: "差し戻し:本人確認書類", detail: "ぼやけています" });
    expect(docReviewEvent(row, DEAL, false).detail).toBeNull();
    expect(docReviewEvent({ ...row, action: "received", reason: null }, DEAL, true).title).toBe("受領:本人確認書類");
  });

  it("提出用リンクは発行と無効化を別の行にする", () => {
    const row = { id: "1", partyRole: "buyer", createdAt: at("2026-10-15T00:00:00Z"), revokedAt: at("2026-10-16T00:00:00Z"), createdBy: author };
    const issued = docLinkIssuedEvent(row, DEAL);
    const revoked = docLinkRevokedEvent(row, DEAL);
    expect([issued.title, revoked.title]).toEqual(["買主の提出用リンクを発行", "買主の提出用リンクを無効化"]);
    expect(issued.id).not.toBe(revoked.id);
    expect(revoked.at).toBe("2026-10-16T00:00:00.000Z");
  });

  it("取引の作成を行にする", () => {
    expect(dealCreatedEvent({ createdAt: at("2026-10-17T00:00:00Z"), createdBy: author }, DEAL)).toMatchObject({ source: "deal_created", category: "change", title: "取引を作成", dealLabel: DEAL.label });
  });
});

describe("変更履歴の変換", () => {
  it("1項目の変更は画面の名前と変更前後を出す", () => {
    const [e] = changeEvents([changeRow()], ctx()).events;
    expect(e).toMatchObject({ source: "change", category: "change", actor: "担当A", title: "案件ステータスを変更" });
    expect(e.detail).toContain("→");
    expect(e.detail).not.toContain("new_case");
  });

  it("同じ時刻・同じ人の変更は1行にまとめる", () => {
    const rows = [changeRow({ id: "a", fieldName: "address", oldValue: "旧", newValue: "新" }), changeRow({ id: "b", fieldName: "lotNumber", oldValue: "1", newValue: "2" })];
    const { events } = changeEvents(rows, ctx());
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("物件の情報を変更(住所・地番)");
    expect(events[0].detail).toContain("住所:旧 → 新");
  });

  it("多くの項目はほかの数でまとめる", () => {
    const names = ["address", "lotNumber", "buildingName", "roomNo", "access"];
    const { events } = changeEvents(names.map((fieldName, i) => changeRow({ id: String(i), fieldName, oldValue: "a", newValue: "b" })), ctx());
    expect(events[0].title).toBe("物件の情報を変更(住所・地番・物件名 ほか2項目)");
  });

  it("時刻か人が違えば別の行にする", () => {
    const rows = [changeRow({ id: "a" }), changeRow({ id: "b", changedAt: at("2026-11-01T02:00:00Z") }), changeRow({ id: "c", changer: { name: "担当B" } })];
    expect(changeEvents(rows, ctx()).events).toHaveLength(3);
  });

  it("自動の変更は人の名前を出さない", () => {
    expect(changeEvents([changeRow({ source: "auto" })], ctx()).events[0].actor).toBe("自動");
  });

  it("問い合わせ者の値は元の画面と同じに伏せる", () => {
    const row = changeRow({ fieldName: "inquirerName", oldValue: null, newValue: "鈴木一郎" });
    expect(JSON.stringify(changeEvents([row], ctx({ inquirerLevel: null })).events)).not.toContain("鈴木一郎");
    expect(changeEvents([row], ctx({ inquirerLevel: null })).events[0].detail).toContain("（非表示）");
    expect(JSON.stringify(changeEvents([row], ctx({ inquirerLevel: "hidden" })).events)).not.toContain("鈴木一郎");
  });

  it("所有者とのつながりの備考は owner_note のレベルで絞る", () => {
    const row = changeRow({ targetTable: "property_owners", targetId: "po1", fieldName: "note", oldValue: "旧メモ", newValue: "新メモ" });
    const visible = changeEvents([row], ctx()).events;
    expect(visible[0]).toMatchObject({ source: "owner_change" });
    expect(visible[0].detail).toContain("新メモ");
    const meta = changeEvents([row], ctx({ ownerNote: "meta_only" })).events;
    expect(meta).toHaveLength(1);
    expect(JSON.stringify(meta)).not.toContain("メモ\"");
    expect(JSON.stringify(meta)).not.toContain("新メモ");
    expect(changeEvents([row], ctx({ ownerNote: "hidden" })).events).toHaveLength(0);
  });

  it("備考以外のつながりの項目は hidden でも残す", () => {
    const row = changeRow({ targetTable: "property_owners", targetId: "po1", fieldName: "relationship", oldValue: "本人", newValue: "相続人" });
    expect(changeEvents([row], ctx({ ownerNote: "hidden" })).events).toHaveLength(1);
  });

  it("担当者の値は名前に直し、それ以外の ID は値を出さない", () => {
    const uid = "66666666-6666-4666-8666-666666666666";
    const named = changeEvents([changeRow({ fieldName: "assignedTo", oldValue: null, newValue: uid })], ctx({ userNames: new Map([[uid, "担当C"]]) })).events[0];
    expect(named.detail).toContain("担当C");
    expect(named.detail).not.toContain(uid);
    const other = changeEvents([changeRow({ fieldName: "dmScenarioId", oldValue: null, newValue: uid })], ctx()).events[0];
    expect(other.detail ?? "").not.toContain(uid);
  });

  it("取引の状態は取引の行として、画面の名前で出す", () => {
    const row = changeRow({ targetTable: "deals", targetId: DEAL.id, fieldName: "status", oldValue: "considering", newValue: "contracted" });
    expect(changeEvents([row], ctx()).events[0]).toMatchObject({ title: "取引の状態を変更", detail: "契約予定 → 契約済", dealLabel: DEAL.label, href: `/deals/${DEAL.id}` });
  });

});

describe("並び順と上限", () => {
  const ev = (id: string, iso: string): TimelineEvent => ({ id, at: iso, dateOnly: false, source: "comment", category: "contact", actor: null, title: id, detail: null, href: null, dealLabel: null });

  it("新しい順に並べる", () => {
    const r = mergeTimeline([ev("a", "2026-01-01T00:00:00.000Z"), ev("c", "2026-03-01T00:00:00.000Z"), ev("b", "2026-02-01T00:00:00.000Z")], 10);
    expect(r.events.map((e) => e.id)).toEqual(["c", "b", "a"]);
    expect(r.nextBefore).toBeNull();
  });

  it("上限を超えたら次の開始点を返す", () => {
    const r = mergeTimeline([ev("a", "2026-01-01T00:00:00.000Z"), ev("b", "2026-02-01T00:00:00.000Z"), ev("c", "2026-03-01T00:00:00.000Z")], 2);
    expect(r.events.map((e) => e.id)).toEqual(["c", "b"]);
    expect(r.nextBefore).toBe("2026-02-01T00:00:00.000Z");
  });

  it("同じ時刻の行はページの境目で分けない", () => {
    const t = "2026-02-01T00:00:00.000Z";
    const r = mergeTimeline([ev("a", t), ev("b", t), ev("c", t), ev("d", "2026-01-01T00:00:00.000Z")], 2);
    expect(r.events.map((e) => e.id).sort()).toEqual(["a", "b", "c"]);
    expect(r.nextBefore).toBe(t);
  });

  it("読み切っていない時刻より古い行は出さず、その時刻から続きを読む", () => {
    const floor = "2026-02-01T00:00:00.000Z";
    const r = mergeTimeline([ev("new", "2026-03-01T00:00:00.000Z"), ev("edge", floor), ev("old", "2026-01-01T00:00:00.000Z")], 10, { floor });
    expect(r.events.map((e) => e.id)).toEqual(["new", "edge"]);
    expect(r.nextBefore).toBe(floor);
  });

  it("上限で切れるなら、読み切っていない時刻より手前の行から続きを読む", () => {
    const floor = "2026-01-01T00:00:00.000Z";
    const r = mergeTimeline([ev("a", "2026-03-01T00:00:00.000Z"), ev("b", "2026-02-01T00:00:00.000Z"), ev("c", floor)], 2, { floor });
    expect(r.nextBefore).toBe("2026-02-01T00:00:00.000Z");
  });

  it("見える行が1つも無くても、読み切っていない時刻から先へ進める", () => {
    const floor = "2026-01-01T00:00:00.000Z";
    expect(mergeTimeline([], 10, { floor })).toEqual({ events: [], nextBefore: floor });
  });

  it("上限に届いた出どころがあれば、同じ時刻の行で出し切っても続きがあると返す", () => {
    const t = "2026-02-01T00:00:00.000Z";
    expect(mergeTimeline([ev("a", t), ev("b", t), ev("c", t)], 2, { more: true }).nextBefore).toBe(t);
    expect(mergeTimeline([ev("a", t), ev("b", t), ev("c", t)], 2).nextBefore).toBeNull();
    expect(mergeTimeline([], 2, { more: true }).nextBefore).toBeNull();
  });
});

describe("絞り込み", () => {
  it("種類ごとの出どころに重なりが無く、全部がどれかに入る", () => {
    const groups = (["contact", "document", "schedule", "change"] as const).map((c) => sourcesForCategory(c));
    const all = groups.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(sourcesForCategory("all").slice().sort()).toEqual(all.slice().sort());
  });

  it("依頼文のコピーはやり取り、取引の状態はデータの変更", () => {
    expect(categoryOf("request_copy")).toBe("contact");
    expect(categoryOf("change")).toBe("change");
    expect(categoryOf("doc_review")).toBe("document");
    expect(categoryOf("schedule")).toBe("schedule");
  });
});

describe("直近の状況", () => {
  it("次の段取りはいちばん早いもの", () => {
    const s = buildTimelineSummary({
      statuses: [{ label: "案件ステータス", value: "販売中" }],
      nextCandidates: [{ label: "後", due: "2026-12-01" }, { label: "先", due: "2026-11-05" }],
      lastContactAt: "2026-10-01T00:00:00.000Z", pendingDocs: 3,
    });
    expect(s.next).toEqual({ label: "先", due: "2026-11-05" });
    expect(s).toMatchObject({ lastContactAt: "2026-10-01T00:00:00.000Z", pendingDocs: 3 });
  });

  it("何も無ければ空で返す", () => {
    expect(buildTimelineSummary({ statuses: [], nextCandidates: [], lastContactAt: null, pendingDocs: null })).toEqual({ statuses: [], next: null, lastContactAt: null, pendingDocs: null, preIntroPending: 0 });
  });

  it("導入前の未完了の件数は、次の段取りが無いときだけ返す", () => {
    const base = { statuses: [], lastContactAt: null, pendingDocs: null, preIntroPending: 2 };
    expect(buildTimelineSummary({ ...base, nextCandidates: [] }).preIntroPending).toBe(2);
    expect(buildTimelineSummary({ ...base, nextCandidates: [{ label: "鍵", due: "2026-11-10" }] }).preIntroPending).toBe(0);
  });
});

describe("権限の判定", () => {
  const perm = (resource: string, action: string) => ({ resource, action, granted: true });
  const session = { id: "u1", role: "office_staff" };
  const property = { createdBy: "x", assignedTo: "y" };

  it("物件を見られないと物件の出どころは全部閉じる", () => {
    const a = timelineAccess({ id: "u1", role: "field_staff" }, [perm("property", "read"), perm("owner", "read"), perm("owner_note", "full")], property);
    expect(a).toMatchObject({ property: false, ownerLinks: false, dm: false, memo: "hidden", material: false });
  });

  it("property:read が無いと物件の出どころは閉じる", () => {
    expect(timelineAccess(session, [perm("deal", "read")], property)).toMatchObject({ property: false, deal: true });
  });

  it("owner:read が無いと所有者メモ・DM・つながりは閉じ、問い合わせ者は伏せる", () => {
    const a = timelineAccess(session, [perm("property", "read"), perm("owner_note", "full")], property);
    expect(a).toMatchObject({ property: true, ownerLinks: false, dm: false, memo: "hidden", inquirerLevel: null });
  });

  it("owner_note のレベルを所有者メモの見せ方にする", () => {
    const base = [perm("property", "read"), perm("owner", "read")];
    expect(timelineAccess(session, [...base, perm("owner_note", "partial")], property)).toMatchObject({ memo: "meta_only", ownerNote: "meta_only", dm: true, noteLevel: "partial" });
    expect(timelineAccess(session, [...base, perm("owner_note", "full")], property).memo).toBe("visible");
    expect(timelineAccess(session, base, property).memo).toBe("hidden");
  });

  it("資料の送付は反響の受付の権限も要る", () => {
    expect(timelineAccess(session, [perm("property", "read")], property).material).toBe(false);
    expect(timelineAccess(session, [perm("property", "read"), perm("agent_inquiry", "read")], property).material).toBe(true);
  });

  it("差し戻しの理由は deal:write の人だけ", () => {
    expect(timelineAccess(session, [perm("deal", "read")], null)).toMatchObject({ deal: true, dealManage: false, property: false });
    expect(timelineAccess(session, [perm("deal", "read"), perm("deal", "write")], null).dealManage).toBe(true);
  });
});

describe("足した記録", () => {
  const audit = (s: string, name = "担当B") => ({ createdAt: at(s), user: { name } });

  it("★操作の人は、その時刻の直後の最初の監査ログ(後でもう一度押した記録を拾わない)", () => {
    const done = at("2026-10-14T00:00:00Z");
    expect(actorOfAudit(done, [audit("2026-10-14T00:00:30Z", "二度目"), audit("2026-10-14T00:00:01Z", "本人")])).toBe("本人");
    expect(actorOfAudit(done, [audit("2026-10-14T00:05:00Z")])).toBeNull();
    expect(actorOfAudit(done, [audit("2026-10-13T23:50:00Z")])).toBeNull();
    expect(actorOfAudit(done, [])).toBeNull();
  });

  it("★完了→取り消し→別の人が完了(すぐあと)でも、今の完了の人を出す", () => {
    const current = at("2026-10-14T00:00:03Z");
    expect(actorOfAudit(current, [
      audit("2026-10-14T00:00:01Z", "前の人"), audit("2026-10-14T00:00:03.200Z", "今の人"),
    ])).toBe("今の人");
    // 今の完了の記録が無ければ、前の人を出さず空にする。
    expect(actorOfAudit(current, [audit("2026-10-14T00:00:01Z", "前の人")])).toBeNull();
  });

  it("★段取りの完了に人を出す・自動の完了には出さない・取り消しの行", () => {
    const row = { id: "s1", label: "鍵の受領", completedAt: at("2026-10-14T00:00:00Z"), autoCompleted: false };
    expect(scheduleEvent(row, DEAL, "担当B").actor).toBe("担当B");
    expect(scheduleEvent({ ...row, autoCompleted: true }, DEAL, "担当B")).toMatchObject({ actor: null, title: "段取りを完了:鍵の受領(自動)" });
    expect(scheduleUndoEvent({ id: "a1", createdAt: at("2026-10-15T00:00:00Z"), user: author }, "鍵の受領", DEAL)).toMatchObject({
      source: "schedule", title: "段取りの完了を取り消し:鍵の受領", actor: "担当A",
    });
  });

  it("次にやることの完了に人を出す", () => {
    const row = { id: "n1", content: "電話", completedAt: at("2026-10-14T00:00:00Z") };
    expect(nextActionCompletedEvent(row, PID, "担当B").actor).toBe("担当B");
    expect(nextActionCompletedEvent(row, PID).actor).toBeNull();
  });

  const ownerRow = (over: Record<string, unknown> = {}) => changeRow({ targetTable: "owners", targetId: "o1", fieldName: "address", oldValue: "東京都旧住所", newValue: "東京都新住所", ...over });

  it("★所有者本体の変更: そのまま見られる人にだけ値を出す", () => {
    const { events } = changeEvents([ownerRow()], ctx());
    expect(events[0]).toMatchObject({ source: "owner_change", title: "所有者の登記上の住所を変更", detail: "東京都旧住所 → 東京都新住所" });
  });

  it("★所有者本体の変更: 一部表示は項目名だけ・値を一切出さない", () => {
    const levels = { ...ctx().ownerLevels, address: "partial" };
    const { events } = changeEvents([ownerRow()], ctx({ ownerLevels: levels }));
    expect(events[0].title).toBe("所有者の登記上の住所を変更");
    expect(JSON.stringify(events)).not.toContain("東京都");
  });

  it("★所有者本体の変更: 非表示なら行を出さない・まとめた行でも値や項目が混ざらない", () => {
    const levels = { ...ctx().ownerLevels, address: "hidden" };
    expect(changeEvents([ownerRow()], ctx({ ownerLevels: levels })).events).toEqual([]);
    const { events } = changeEvents([ownerRow(), ownerRow({ id: "x2", fieldName: "phone", oldValue: "03-1", newValue: "03-2" })], ctx({ ownerLevels: levels }));
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("所有者の電話番号を変更");
    expect(JSON.stringify(events)).not.toContain("東京都");
  });

  it("★所有者本体の変更: 一覧に無い項目(統合の印など)は出さない", () => {
    expect(changeEvents([ownerRow({ fieldName: "_merged_from", newValue: "11111111-1111-4111-8111-111111111111" })], ctx()).events).toEqual([]);
    expect(changeEvents([ownerRow({ fieldName: "isArchived" })], ctx()).events).toEqual([]);
  });

  it.each(["_unlinked_from_property", "_deleted_via_mislink_correction", "_deleted_via_merge"])("★%s は「紐づけを解除」の1行・所有者の ID を出さない", (fieldName) => {
    const owner = "99999999-9999-4999-8999-999999999999";
    const { events } = changeEvents([
      changeRow({ targetTable: "property_owners", targetId: "l1", fieldName, oldValue: owner, newValue: null }),
      changeRow({ id: "x2", targetTable: "property_owners", targetId: "l1", fieldName: "isPrimary", oldValue: "true", newValue: null }),
    ], ctx());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: "owner_change", title: "所有者の紐づけを解除" });
    expect(JSON.stringify(events)).not.toContain(owner);
  });
});
