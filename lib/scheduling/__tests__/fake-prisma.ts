/**
 * An in-memory stand-in for the slice of Prisma the scheduling code uses
 * (lib/scheduling/store.ts, lib/scheduling/runner.ts), so the tests run the
 * real store, routes and runner end to end.
 *
 * Faithful where the guarantees live:
 *   - `where` filters are actually evaluated (equality, `in`, `not`, `gt`,
 *     `gte`, `lt`, `lte`, `OR`); an unsupported operator throws rather than
 *     silently matching, so a missing scoping filter really does leak here.
 *   - `activeDraftId` is unique, like the real index: a create or update that
 *     would duplicate it throws Prisma's P2002.
 *   - Every method does all its reading and writing synchronously before its
 *     promise settles, so a conditional `updateMany` is atomic with respect to
 *     any other call — the same guarantee a single UPDATE gives in Postgres.
 */

export interface FakeScheduledListing {
  id: string;
  userId: string;
  shopId: string;
  draftId: string | null;
  activeDraftId: string | null;
  scheduledAt: Date;
  timezone: string;
  status: string;
  publishSpec: unknown;
  renderSetId: string | null;
  images: unknown;
  attemptCount: number;
  nextAttemptAt: Date | null;
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

export const db = {
  scheduled: new Map<string, FakeScheduledListing>(),
  drafts: new Map<string, FakeDraft>(),
  nextId: 1,
};

export function resetDb(): void {
  db.scheduled.clear();
  db.drafts.clear();
  db.nextId = 1;
}

type Where = Record<string, unknown>;

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

const time = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number));

function matches(row: object, where: Where | undefined): boolean {
  if (!where) return true;
  const r = row as Record<string, unknown>;
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === "OR") return (cond as Where[]).some((w) => matches(row, w));
    const value = r[key];
    if (cond === null || typeof cond !== "object" || cond instanceof Date) return same(value, cond);
    return Object.entries(cond as Record<string, unknown>).every(([op, arg]) => {
      switch (op) {
        case "in":
          return (arg as unknown[]).some((a) => same(value, a));
        case "not":
          return !same(value, arg);
        case "gt":
          return value != null && time(value) > time(arg);
        case "gte":
          return value != null && time(value) >= time(arg);
        case "lt":
          return value != null && time(value) < time(arg);
        case "lte":
          return value != null && time(value) <= time(arg);
        default:
          throw new Error(`fake prisma: unsupported operator "${op}" on "${key}"`);
      }
    });
  });
}

export function uniqueViolation(): Error {
  return Object.assign(new Error("Unique constraint failed on the fields: (`activeDraftId`)"), { code: "P2002" });
}

function assertUniqueActiveDraft(activeDraftId: unknown, exceptId: string | null): void {
  if (activeDraftId == null) return;
  for (const row of db.scheduled.values()) {
    if (row.id !== exceptId && row.activeDraftId === activeDraftId) throw uniqueViolation();
  }
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
    activeDraftId: null,
    timezone: "UTC",
    status: "pending",
    publishSpec: null,
    renderSetId: null,
    images: [],
    attemptCount: 0,
    nextAttemptAt: null,
    lastError: null,
    etsyListingId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...row,
  };
  assertUniqueActiveDraft(full.activeDraftId, full.id);
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
  select?: unknown;
  orderBy?: { scheduledAt: "asc" | "desc" };
  take?: number;
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
    async findUnique({ where, include }: Args) {
      const row = db.scheduled.get((where as { id: string }).id);
      return row ? withDraft(row, include) : null;
    },
    async findMany({ where, include, orderBy, take }: Args) {
      let rows = [...db.scheduled.values()].filter((r) => matches(r, where));
      if (orderBy?.scheduledAt) {
        const dir = orderBy.scheduledAt === "asc" ? 1 : -1;
        rows.sort((a, b) => dir * (a.scheduledAt.getTime() - b.scheduledAt.getTime()));
      }
      if (take != null) rows = rows.slice(0, take);
      return rows.map((r) => withDraft(r, include));
    },
    async updateMany({ where, data }: Args) {
      const targets = [...db.scheduled.values()].filter((r) => matches(r, where));
      if (data && "activeDraftId" in data) {
        for (const row of targets) assertUniqueActiveDraft(data.activeDraftId, row.id);
      }
      for (const row of targets) Object.assign(row, data, { updatedAt: new Date() });
      return { count: targets.length };
    },
  },
  listingDraft: {
    async findFirst({ where }: Args) {
      return [...db.drafts.values()].find((d) => matches(d, where)) ?? null;
    },
  },
};
