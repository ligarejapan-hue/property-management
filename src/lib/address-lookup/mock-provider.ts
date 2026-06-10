/**
 * 開発用 mock provider（NEXT_PUBLIC_USE_MOCK=true 時）。外部 I/O に触れない。
 */

import { normalizePostalCode } from "./normalize";
import type { AddressLookupCandidate, AddressLookupProvider } from "./types";

export class MockAddressLookupProvider implements AddressLookupProvider {
  readonly name = "mock";

  async lookupByPostalCode(postalCode7: string): Promise<AddressLookupCandidate[]> {
    const zip = normalizePostalCode(postalCode7) || "1000005";
    return [
      {
        postalCode: zip,
        prefecture: "東京都",
        city: "千代田区",
        town: "丸の内",
        addressLine: "東京都千代田区丸の内",
        source: this.name,
      },
    ];
  }

  async searchByAddress(address: string): Promise<AddressLookupCandidate[]> {
    const line = address.trim() || "東京都千代田区丸の内";
    return [
      {
        postalCode: "1000005",
        prefecture: "東京都",
        city: "千代田区",
        town: "丸の内",
        addressLine: line,
        source: this.name,
      },
    ];
  }
}
