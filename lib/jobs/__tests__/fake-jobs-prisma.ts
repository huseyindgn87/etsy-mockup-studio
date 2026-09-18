/**
 * In-memory `etsyJob` / `etsyJobTurn` models — the slice of Prisma the job
 * queue uses — so tests run the real queue, worker and routes.
 *
 * Faithful where the guarantees live: `where` filters are evaluated
 * (equality, `in`, `not`, `lt`, `lte`, `gt`, `gte`, `OR`; anything else
 * throws), `activeKey` is unique (P2002), `distinct` keeps the first row per
 * value in `orderBy` order, and every call does its reads and writes before
 * its promise settles, so a conditional `updateMany` is atomic like a single
 * Postgres UPDATE.
 */

import { Prisma, type EtsyJob } from "@prisma/client";

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

export const jobsDb = {
  jobs: new Map<string, EtsyJob>(),
  turns: new Map<string, { userId: string; lastServedAt: Date }>(),
  nextId: 1,
  /** Advances with every write so `createdAt` ties can't happen by accident. */
  clock: () => new Date(),
};

export function resetJobsDb(clock: () => Date = () => new Date()): void {
  jobsDb.jobs.clear();
  jobsDb.turns.clear();
  jobsDb.nextId = 1;
  jobsDb.clock = clock;
}

const time = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number));
const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

export function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === "OR") return (cond as Where[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond === null || typeof cond !== "object" || cond instanceof Date) return same(value, cond);
    return Object.entries(cond as Row).every(([op, arg]) => {
      switch (op) {
        case "in":
          return (arg as unknown[]).some((a) => same(value, a));
        case "not":
          return !same(value, arg);
        case "lt":
          return value != null && time(value) < time(arg);
        case "lte":
          return value != null && time(value) <= time(arg);
        case "gt":
          return value != null && time(value) > time(arg);
        case "gte":
          return value != null && time(value) >= time(arg);
        default:
          throw new Error(`fake jobs prisma: unsupported operator "${op}" on "${key}"`);
      }
    });
  });
}

function uniqueViolation(): Error {
  return Object.assign(new Error("Unique constraint failed on the fields: (`activeKey`)"), { code: "P2002" });
}

function assertUniqueKey(activeKey: unknown, exceptId: string | null) {
  if (activeKey == null) return;
  for (const job of jobsDb.jobs.values()) {
    if (job.id !== exceptId && job.activeKey === activeKey) throw uniqueViolation();
  }
}

type OrderBy = Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[];

function sortRows<T extends Row>(rows: T[], orderBy: OrderBy | undefined): T[] {
  const keys = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o)) : [];
  return [...rows].sort((a, b) => {
    for (const [key, dir] of keys) {
      const d = time(a[key]) - time(b[key]);
      if (d !== 0) return dir === "asc" ? d : -d;
    }
    return 0;
  });
}

function pick(row: Row, select: Record<string, boolean> | undefined): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

/** A job row with every column defaulted, the way the database would. */
export function seedJob(data: Partial<EtsyJob> & Pick<EtsyJob, "userId" | "type" | "priority">): EtsyJob {
  const now = jobsDb.clock();
  const job: EtsyJob = {
    id: `job${jobsDb.nextId++}`,
    shopId: null,
    payload: {},
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    progress: null,
    result: null,
    error: null,
    activeKey: null,
    runAfter: now,
    lockToken: null,
    lockedUntil: null,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    ...data,
  } as EtsyJob;
  assertUniqueKey(job.activeKey, job.id);
  jobsDb.jobs.set(job.id, job);
  return job;
}

/** Prisma's `JsonNull` / `DbNull` sentinels store null. */
function normalise(data: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(data)) out[k] = v === Prisma.JsonNull || v === Prisma.DbNull ? null : v;
  return out;
}

export const fakeJobModels = {
  etsyJob: {
    async create({ data }: { data: Row }) {
      return { ...seedJob(normalise(data) as unknown as EtsyJob) };
    },
    async findFirst({ where }: { where?: Where }) {
      const row = [...jobsDb.jobs.values()].find((j) => matches(j as unknown as Row, where));
      return row ? { ...row } : null;
    },
    async findUnique({ where }: { where: { id: string } }) {
      const row = jobsDb.jobs.get(where.id);
      return row ? { ...row } : null;
    },
    async findMany({
      where,
      orderBy,
      take,
      distinct,
      select,
    }: {
      where?: Where;
      orderBy?: OrderBy;
      take?: number;
      distinct?: string[];
      select?: Record<string, boolean>;
    }) {
      let rows = sortRows(
        [...jobsDb.jobs.values()].map((j) => j as unknown as Row).filter((j) => matches(j, where)),
        orderBy,
      );
      if (distinct) {
        const seen = new Set<string>();
        rows = rows.filter((r) => {
          const key = distinct.map((d) => String(r[d])).join("\u0000");
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      if (take != null) rows = rows.slice(0, take);
      return rows.map((r) => pick(r, select));
    },
    async count({ where }: { where?: Where }) {
      return [...jobsDb.jobs.values()].filter((j) => matches(j as unknown as Row, where)).length;
    },
    async updateMany({ where, data }: { where?: Where; data: Row }) {
      const targets = [...jobsDb.jobs.values()].filter((j) => matches(j as unknown as Row, where));
      const clean = normalise(data);
      if ("activeKey" in clean) for (const t of targets) assertUniqueKey(clean.activeKey, t.id);
      for (const t of targets) Object.assign(t, clean, { updatedAt: jobsDb.clock() });
      return { count: targets.length };
    },
  },
  etsyJobTurn: {
    async findMany({ where }: { where?: Where }) {
      return [...jobsDb.turns.values()].filter((t) => matches(t as unknown as Row, where)).map((t) => ({ ...t }));
    },
    async upsert({ where, create, update }: { where: { userId: string }; create: { userId: string; lastServedAt: Date }; update: { lastServedAt: Date } }) {
      const existing = jobsDb.turns.get(where.userId);
      const row = existing ? { ...existing, ...update } : { ...create };
      jobsDb.turns.set(where.userId, row);
      return { ...row };
    },
  },
};
