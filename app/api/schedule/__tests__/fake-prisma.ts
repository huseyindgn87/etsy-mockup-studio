/**
 * An in-memory stand-in for the slice of Prisma lib/scheduling/store.ts uses,
 * so the schedule API tests run the real routes and the real store end to
 * end. `where` filters are actually evaluated (equality, `in`, `not`, `gte`,
 * `lt`) and an unsupported operator throws rather than silently matching —
 * so a scoping filter the store forgets really does leak in these tests.
 */

export interface FakeScheduledListing {
  id: string;
  userId: string;
  shopId: string;
  draftId: string | null;
  listingId: string | null;
  scheduledAt: Date;
  timezone: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  etsyListingId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeDraft {
  id: string;
  userId: string;
  title: string;
  hasThumbnail: boolean;
}

export interface FakeListing {
  id: string;
  userId: string;
  shopId: string;
  listingId: string;
  title: string;
  thumbnailUrl: string | null;
  removedAt: Date | null;
}

export const db = {
  scheduled: new Map<string, FakeScheduledListing>(),
  drafts: new Map<string, FakeDraft>(),
  listings: [] as FakeListing[],
  nextId: 1,
};

export function resetDb(): void {
  db.scheduled.clear();
  db.drafts.clear();
  db.listings.length = 0;
  db.nextId = 1;
}

type Where = Record<string, unknown>;

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function matches(row: object, where: Where | undefined): boolean {
  if (!where) return true;
  const r = row as Record<string, unknown>;
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    const value = r[key];
    if (cond === null || typeof cond !== "object" || cond instanceof Date) return same(value, cond);
    return Object.entries(cond as Record<string, unknown>).every(([op, arg]) => {
      switch (op) {
        case "in":
          return (arg as unknown[]).some((a) => same(value, a));
        case "not":
          return !same(value, arg);
        case "gte":
          return (value as Date).getTime() >= (arg as Date).getTime();
        case "lt":
          return (value as Date).getTime() < (arg as Date).getTime();
        default:
          throw new Error(`fake prisma: unsupported operator "${op}" on "${key}"`);
      }
    });
  });
}

function withDraft(row: FakeScheduledListing, include: unknown) {
  if (!include) return { ...row };
  const draft = row.draftId ? db.drafts.get(row.draftId) : undefined;
  return { ...row, draft: draft ? { title: draft.title, hasThumbnail: draft.hasThumbnail } : null };
}

export function seedScheduled(
  row: Pick<FakeScheduledListing, "userId" | "shopId" | "scheduledAt"> & Partial<FakeScheduledListing>,
): FakeScheduledListing {
  const full: FakeScheduledListing = {
    id: `s${db.nextId++}`,
    draftId: null,
    listingId: null,
    timezone: "UTC",
    status: "pending",
    attemptCount: 0,
    lastError: null,
    etsyListingId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...row,
  };
  db.scheduled.set(full.id, full);
  return full;
}

export function seedDraft(row: Pick<FakeDraft, "id" | "userId"> & Partial<FakeDraft>): FakeDraft {
  const full: FakeDraft = { title: "", hasThumbnail: false, ...row };
  db.drafts.set(full.id, full);
  return full;
}

interface Args {
  where?: Where;
  data?: Record<string, unknown>;
  include?: unknown;
  orderBy?: { scheduledAt: "asc" | "desc" };
}

export const fakePrisma = {
  scheduledListing: {
    async create({ data, include }: Args) {
      const row = seedScheduled(data as unknown as FakeScheduledListing);
      return withDraft(row, include);
    },
    async findFirst({ where, include }: Args) {
      const row = [...db.scheduled.values()].find((r) => matches(r, where));
      return row ? withDraft(row, include) : null;
    },
    async findMany({ where, include, orderBy }: Args) {
      const rows = [...db.scheduled.values()].filter((r) => matches(r, where));
      if (orderBy?.scheduledAt) {
        const dir = orderBy.scheduledAt === "asc" ? 1 : -1;
        rows.sort((a, b) => dir * (a.scheduledAt.getTime() - b.scheduledAt.getTime()));
      }
      return rows.map((r) => withDraft(r, include));
    },
    async updateMany({ where, data }: Args) {
      let count = 0;
      for (const row of db.scheduled.values()) {
        if (!matches(row, where)) continue;
        Object.assign(row, data, { updatedAt: new Date() });
        count++;
      }
      return { count };
    },
  },
  listingDraft: {
    async findFirst({ where }: Args) {
      return [...db.drafts.values()].find((d) => matches(d, where)) ?? null;
    },
  },
  listing: {
    async findFirst({ where }: Args) {
      return db.listings.find((l) => matches(l, where)) ?? null;
    },
    async findMany({ where }: Args) {
      return db.listings.filter((l) => matches(l, where));
    },
  },
};
