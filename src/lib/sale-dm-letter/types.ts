export interface LetterRecipient {
  representativeName: string; // 代表所有者名(生値)
  honorific: string;          // "様" / "御中" 等(honorificForOwner の戻り)
  coOwnerCount: number;       // 同送付先の共有者数(>1 で「他共有者様」)
  propertyAddress: string;
  propertyTypeLabel: string;  // PROPERTY_TYPE_LABELS 経由
  roomNo?: string | null;
}

export interface LetterOptions {
  designTemplate: string; // "formal" | "soft" | "impact"(P2 で使用・P1 は保持)
  tone: string;           // "formal" | "standard" | "soft"
  length: string;         // "short" | "medium" | "long"
  appeal: string;         // "price" | "inheritance" | "vacant" | "buyer"
  strength: string;       // "low" | "medium" | "high"
  senderName: string;
  senderContact: string;
  extraInstruction?: string;
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

export interface LetterProvider {
  readonly name: string;
  generate(prompt: BuiltPrompt): Promise<{ body: string }>;
}

export type SaleDmErrorCode =
  | "NOT_CONFIGURED"
  | "TIMEOUT"
  | "NETWORK"
  | "AUTH_FAILED"
  | "UPSTREAM_4XX"
  | "UPSTREAM_5XX"
  | "RATE_LIMITED"
  | "GENERATION_FAILED";

export class SaleDmError extends Error {
  readonly code: SaleDmErrorCode;
  readonly httpStatus: number | null;
  constructor(code: SaleDmErrorCode, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "SaleDmError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
