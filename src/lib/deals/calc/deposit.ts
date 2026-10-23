/** 敷金の承継(依頼書 3.3)。預り敷金の合計を買主が承継する。相殺=残代金から差し引く / 別途=別に授受する。 */
export function depositSuccession(deposits: number[], mode: "offset" | "separate") {
  return { total: deposits.reduce((a, b) => a + b, 0), mode };
}
