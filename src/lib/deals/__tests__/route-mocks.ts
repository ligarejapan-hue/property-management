/** 取引の route テストの共通 mock。既存の反響の受付の部品を使い回す。 */
export { nextServerMock, apiHelpersMock, jsonRequest } from "@/lib/__tests__/agent-inquiry-route-mocks";
export const DEAL_ID = "11111111-1111-4111-8111-111111111111";
export const PROP_ID = "22222222-2222-4222-8222-222222222222";
export const PARTY_ID = "33333333-3333-4333-8333-333333333333";
export const USER_ID = "66666666-6666-4666-8666-666666666666";
export const DEAL_PERMS = [
  { resource: "deal", action: "read", granted: true },
  { resource: "deal", action: "write", granted: true },
  { resource: "property", action: "read", granted: true },
];
