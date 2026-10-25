import { z } from "zod";
import { isoDate } from "../../schema-parts";
import { html } from "../html";
import { documentHtml } from "../layout";
import { DocOptionError } from "./receipts";
import { dateJa, headTable, namesOf, partiesOf, propertyLabel, signBox, type BusinessDocContext, type Choice, type ValueRow } from "./common";

const keyRow = z.object({ label: z.string().trim().min(1).max(50), count: z.number().int().min(1).max(99) }).strict();
export const keyReceiptOptionsSchema = z.object({
  /** 受領者 = "self"(自社)か自社でない買主の当事者 ID。 */
  receiver: z.string().min(1).max(40),
  keys: z.array(keyRow).max(30),
  receivedOn: isoDate.nullable(),
}).strict();
export type KeyReceiptOptions = z.output<typeof keyReceiptOptionsSchema>;

/** 選べる受領者と初期値(自社の買主がいれば自社、なければ最初の買主・計画の読み替え 2)。 */
export function keyReceiverChoices(c: BusinessDocContext): { choices: Choice[]; initial: string } {
  const buyers = partiesOf(c.deal, "buyer");
  const others = buyers.filter((p) => !p.isSelf);
  return {
    choices: [{ value: "self", label: `${c.company.nameJa}(自社)` }, ...others.map((p) => ({ value: p.id, label: p.name }))],
    initial: buyers.some((p) => p.isSelf) || !others.length ? "self" : others[0].id,
  };
}

/** 鍵受領書(依頼書 4.3)。宛先は売主。受領者の署名・押印の欄は空欄で、自社が受け取るときも角印は付けない。 */
export function buildKeyReceipt(c: BusinessDocContext, o: KeyReceiptOptions): { html: string; rows: ValueRow[] } {
  let receiver: { name: string; address: string | null };
  if (o.receiver === "self") receiver = { name: c.company.nameJa, address: c.company.address || null };
  else {
    const p = partiesOf(c.deal, "buyer").find((x) => x.id === o.receiver && !x.isSelf);
    if (!p) throw new DocOptionError("受け取る人を選び直してください");
    receiver = { name: p.name, address: p.address };
  }
  if (!o.keys.length) throw new DocOptionError("鍵の番号・本数を1行以上入れてください", "NO_KEYS");
  const sellers = namesOf(partiesOf(c.deal, "seller"));
  const total = o.keys.reduce((a, k) => a + k.count, 0);

  const body = html`
<h1>鍵受領書</h1>
<div class="meta"><div class="customer">${sellers ?? ""} 様</div><div class="right">${o.receivedOn ? dateJa(o.receivedOn) : "　　年　　月　　日"}</div></div>
${headTable([["物件", propertyLabel(c.deal)]])}
<h2>受け取った鍵</h2>
<table>
<tr><th>鍵の番号・種類</th><th class="num" style="width:25%">本数</th></tr>
${o.keys.map((k) => html`<tr><td>${k.label}</td><td class="num">${k.count}本</td></tr>`)}
<tr class="total"><th>合計</th><td class="num">合計 ${total}本</td></tr>
</table>
<p>上記の鍵を、確かに受け取りました。</p>
<h2>受領者</h2>
${headTable([["住所", receiver.address], ["氏名(名称)", receiver.name]])}
${signBox("署名・押印")}`;
  return {
    html: documentHtml({ title: "鍵受領書", font: "mincho", body }),
    rows: [
      { label: "書類", value: "鍵受領書" }, { label: "宛先", value: sellers }, { label: "物件", value: propertyLabel(c.deal) },
      { label: "受領日", value: o.receivedOn },
      ...o.keys.map((k) => ({ label: k.label, value: k.count })),
      { label: "合計本数", value: total }, { label: "受領者", value: receiver.name },
    ],
  };
}
