/**
 * An in-memory stand-in for the slice of Prisma the two-factor code uses —
 * shared by lib/account/__tests__/two-factor.test.ts and
 * lib/auth/__tests__/authorize-two-factor.test.ts. It honors the conditional
 * `updateMany` filters the real code relies on for replay protection and
 * single-use recovery codes, so those guarantees are actually exercised.
 */

export interface FakeUser {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string;
  twoFactorEnabled: boolean;
  twoFactorSecret: string | null;
  twoFactorPendingSecret: string | null;
  twoFactorLastUsedStep: number | null;
}

export interface FakeRecoveryCode {
  userId: string;
  codeHash: string;
  usedAt: Date | null;
}

export const db = {
  users: new Map<string, FakeUser>(),
  codes: [] as FakeRecoveryCode[],
};

export function resetDb(): void {
  db.users.clear();
  db.codes.length = 0;
}

export function seedUser(user: Pick<FakeUser, "id" | "email" | "passwordHash"> & Partial<FakeUser>): FakeUser {
  const row: FakeUser = {
    name: null,
    twoFactorEnabled: false,
    twoFactorSecret: null,
    twoFactorPendingSecret: null,
    twoFactorLastUsedStep: null,
    ...user,
  };
  db.users.set(row.id, row);
  return row;
}

type StepFilter = { twoFactorLastUsedStep: null } | { twoFactorLastUsedStep: { lt: number } };

function matchesStep(user: FakeUser, filter: StepFilter): boolean {
  const f = filter.twoFactorLastUsedStep;
  if (f === null) return user.twoFactorLastUsedStep === null;
  return user.twoFactorLastUsedStep !== null && user.twoFactorLastUsedStep < f.lt;
}

// Every method does its work synchronously before returning its promise, so
// `$transaction([...])` applies operations in array order, like Prisma.
export const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
      if (where.id) return db.users.get(where.id) ?? null;
      return [...db.users.values()].find((u) => u.email === where.email) ?? null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakeUser> }) => {
      const user = db.users.get(where.id);
      if (!user) throw new Error("Record not found.");
      Object.assign(user, data);
      return user;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; OR?: StepFilter[] };
      data: Partial<FakeUser>;
    }) => {
      const user = db.users.get(where.id);
      if (!user || (where.OR && !where.OR.some((f) => matchesStep(user, f)))) return { count: 0 };
      Object.assign(user, data);
      return { count: 1 };
    },
  },
  twoFactorRecoveryCode: {
    deleteMany: async ({ where }: { where: { userId: string } }) => {
      const before = db.codes.length;
      db.codes = db.codes.filter((c) => c.userId !== where.userId);
      return { count: before - db.codes.length };
    },
    createMany: async ({ data }: { data: { userId: string; codeHash: string }[] }) => {
      for (const row of data) db.codes.push({ ...row, usedAt: null });
      return { count: data.length };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { userId: string; codeHash: string; usedAt: null };
      data: { usedAt: Date };
    }) => {
      const matches = db.codes.filter(
        (c) => c.userId === where.userId && c.codeHash === where.codeHash && c.usedAt === null,
      );
      for (const c of matches) c.usedAt = data.usedAt;
      return { count: matches.length };
    },
    count: async ({ where }: { where: { userId: string; usedAt: null } }) =>
      db.codes.filter((c) => c.userId === where.userId && c.usedAt === null).length,
  },
  $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
};
