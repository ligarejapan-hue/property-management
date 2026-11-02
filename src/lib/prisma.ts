import { PrismaClient } from "@/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { halfWidthDigitsInWrite } from "@/lib/notation";

const connectionString = process.env.DATABASE_URL!;
const adapter = new PrismaPg(connectionString);

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

/**
 * 住所・番号の数字を半角で保存する(lib/notation.ts)。書き込みの経路が多いので、ここで1か所にする。
 * ⚠生の SQL には効かない(この項目を生の SQL で書く場所は今は無い)。
 * 型は元のまま見せる(取引の中の tx を受ける関数の型を変えない)。
 */
function createClient(): PrismaClient {
  const withNotation = (model: string) => ({
    $allOperations({ operation, args, query }: { operation: string; args: unknown; query: (a: never) => Promise<unknown> }) {
      return query(halfWidthDigitsInWrite(model, operation, args) as never);
    },
  });
  return new PrismaClient({ adapter }).$extends({
    query: {
      property: withNotation("property"),
      owner: withNotation("owner"),
      building: withNotation("building"),
      dealParty: withNotation("dealParty"),
      agent: withNotation("agent"),
    },
  }) as unknown as PrismaClient;
}

export const prisma = globalForPrisma.prisma || createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;
