/**
 * The one place this app sends a request to Etsy's API (api.etsy.com — the
 * v3 application endpoints and the OAuth token endpoint). A test fails any
 * other file that names that host.
 *
 * Etsy's limits belong to the API key, so they're shared by every user of the
 * app and every server instance. Their state lives in one database row
 * ({@link EtsyRateLimitStore}), not in memory:
 *
 * - **Per second.** Each request takes a slot in the current wall-clock
 *   second, atomically, up to the per-second limit Etsy last reported
 *   (`x-limit-per-second`; {@link DEFAULT_PER_SECOND} until the first response).
 *   A full second, a response saying `x-remaining-this-second: 0`, or a 429
 *   makes every instance wait.
 * - **Per day.** `x-limit-per-day` / `x-remaining-today` from the last
 *   response. Once the remaining quota falls to a priority's reserve, new
 *   requests of that priority are refused with an {@link EtsyLimitError}
 *   saying when to try again — background work first, interactive later,
 *   token refreshes never.
 * - **Retries.** A 429 waits for `Retry-After` (else exponential backoff with
 *   jitter) and retries up to {@link MAX_RATE_LIMIT_RETRIES} times; a 5xx or a
 *   network error retries with backoff up to {@link MAX_SERVER_RETRIES} times,
 *   but only for methods that are safe to repeat — a POST that may have
 *   reached Etsy could create a second listing. Other 4xx are never retried.
 *
 * Every throttle, retry and give-up is logged with the endpoint and user id.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The Etsy API host. Only this file may name it (see the test). */
export const ETSY_API_ORIGIN = "https://api.etsy.com";

/**
 * Raised for any failed Etsy call. Defined here rather than beside
 * `readEtsyResponse` (lib/etsy/listings.ts, which re-exports it) so
 * {@link EtsyLimitError} can extend it without a circular import.
 */
export class EtsyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "EtsyApiError";
  }
}

/** Etsy's limit is used up (or nearly, for this kind of work). Routes answer it as a 429 with this message. */
export class EtsyLimitError extends EtsyApiError {
  constructor(readonly retryAt: Date) {
    super(`Etsy limit reached, try again after ${formatRetryAt(retryAt)}.`, 429, { retryAt: retryAt.toISOString() });
    this.name = "EtsyLimitError";
  }
}

function formatRetryAt(at: Date): string {
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  const sameDay = at.toISOString().slice(0, 10) === new Date(clock.now()).toISOString().slice(0, 10);
  return sameDay ? `${hh}:${mm} UTC` : `${at.toISOString().slice(0, 10)} ${hh}:${mm} UTC`;
}

/**
 * - `critical`: token exchange/refresh — never refused for the daily budget.
 * - `interactive`: a user waiting on one screen (the default).
 * - `background`: listing sync, bulk writes, the scheduled runner — stopped first.
 */
export type EtsyPriority = "critical" | "interactive" | "background";

/** Per-second limit assumed until Etsy's first response says otherwise (Etsy's default is 10). */
export const DEFAULT_PER_SECOND = 5;
/** Share of the daily limit that must remain for a request of each priority to start. */
export const DAILY_RESERVE: Record<EtsyPriority, number> = { critical: 0, interactive: 0.02, background: 0.1 };
/**
 * Etsy's daily quota is a rolling window with no reset time in its headers.
 * A low reading is trusted for this long; after it, requests are let through
 * again and the next response says whether quota came back.
 */
export const DAILY_RECHECK_MS = 60 * 60 * 1000;
export const MAX_RATE_LIMIT_RETRIES = 3;
export const MAX_SERVER_RETRIES = 3;
/** A wait longer than this isn't held inside a request — it's reported as an {@link EtsyLimitError}. */
export const MAX_IN_REQUEST_WAIT_MS = 60_000;

const RETRY_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"]);

export interface RateLimitHeaders {
  perSecondLimit: number | null;
  remainingThisSecond: number | null;
  perDayLimit: number | null;
  remainingToday: number | null;
}

function headerInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** Etsy's quota headers, each `null` when missing or unreadable. */
export function parseRateLimitHeaders(headers: Headers): RateLimitHeaders {
  return {
    perSecondLimit: headerInt(headers, "x-limit-per-second"),
    remainingThisSecond: headerInt(headers, "x-remaining-this-second"),
    perDayLimit: headerInt(headers, "x-limit-per-day"),
    remainingToday: headerInt(headers, "x-remaining-today"),
  };
}

/** Delay before retry `attempt` (0-based): `Retry-After` (seconds or HTTP date) when present, else exponential backoff with jitter. */
export function retryDelayMs(headers: Headers | null, attempt: number): number {
  const retryAfter = headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - clock.now());
  }
  return 500 * 2 ** attempt + Math.floor(clock.random() * 250);
}

export interface RateLimitState {
  perSecondLimit: number | null;
  perDayLimit: number | null;
  remainingToday: number | null;
  observedAtMs: number | null;
  windowStartMs: number;
  windowCount: number;
  pausedUntilMs: number | null;
}

export interface RateLimitObservation {
  perSecondLimit: number | null;
  perDayLimit: number | null;
  remainingToday: number | null;
  observedAtMs: number;
}

/** Where the shared limiter state lives. Production: one Postgres row; tests: memory. */
export interface EtsyRateLimitStore {
  read(): Promise<RateLimitState>;
  /** Takes a slot in the second containing `nowMs` unless paused or full. Returns whether it did, and the state. */
  tryAcquire(nowMs: number, defaultPerSecond: number): Promise<{ granted: boolean; state: RateLimitState }>;
  /** Records what a response's headers said (only the non-null values). */
  observe(observation: RateLimitObservation): Promise<void>;
  /** Pauses every caller until `untilMs` (never shortens an existing pause). */
  pauseUntil(untilMs: number): Promise<void>;
}

const EMPTY_STATE: RateLimitState = {
  perSecondLimit: null,
  perDayLimit: null,
  remainingToday: null,
  observedAtMs: null,
  windowStartMs: 0,
  windowCount: 0,
  pausedUntilMs: null,
};

/** Same semantics as the Postgres store, in one process — for tests. */
export function createMemoryRateLimitStore(initial: Partial<RateLimitState> = {}): EtsyRateLimitStore & {
  state: RateLimitState;
} {
  const store = {
    state: { ...EMPTY_STATE, ...initial },
    async read() {
      return { ...store.state };
    },
    async tryAcquire(nowMs: number, defaultPerSecond: number) {
      const s = store.state;
      const second = Math.floor(nowMs / 1000) * 1000;
      const paused = s.pausedUntilMs != null && s.pausedUntilMs > nowMs;
      const newWindow = s.windowStartMs < second;
      const full = !newWindow && s.windowCount >= (s.perSecondLimit ?? defaultPerSecond);
      if (paused || full) return { granted: false, state: { ...s } };
      store.state = { ...s, windowStartMs: newWindow ? second : s.windowStartMs, windowCount: newWindow ? 1 : s.windowCount + 1 };
      return { granted: true, state: { ...store.state } };
    },
    async observe(o: RateLimitObservation) {
      store.state = {
        ...store.state,
        perSecondLimit: o.perSecondLimit ?? store.state.perSecondLimit,
        perDayLimit: o.perDayLimit ?? store.state.perDayLimit,
        remainingToday: o.remainingToday ?? store.state.remainingToday,
        observedAtMs: o.remainingToday != null ? o.observedAtMs : store.state.observedAtMs,
      };
    },
    async pauseUntil(untilMs: number) {
      store.state = { ...store.state, pausedUntilMs: Math.max(store.state.pausedUntilMs ?? 0, untilMs) };
    },
  };
  return store;
}

const ROW_ID = "global";

type RateLimitRow = {
  perSecondLimit: number | null;
  perDayLimit: number | null;
  remainingToday: number | null;
  observedAt: Date | null;
  windowStartMs: bigint | number;
  windowCount: number;
  pausedUntil: Date | null;
};

function fromRow(row: RateLimitRow | undefined): RateLimitState {
  if (!row) return { ...EMPTY_STATE };
  return {
    perSecondLimit: row.perSecondLimit,
    perDayLimit: row.perDayLimit,
    remainingToday: row.remainingToday,
    observedAtMs: row.observedAt?.getTime() ?? null,
    windowStartMs: Number(row.windowStartMs),
    windowCount: row.windowCount,
    pausedUntilMs: row.pausedUntil?.getTime() ?? null,
  };
}

/**
 * The `etsy_rate_limit` row. Taking a slot is one conditional upsert, so two
 * instances can't both take the last slot of a second: Postgres locks the row
 * for the update and re-checks the condition against the committed values.
 */
export function createPrismaRateLimitStore(): EtsyRateLimitStore {
  const db = async () => (await import("@/lib/db/prisma")).prisma;
  const read = async () => {
    const prisma = await db();
    const rows = await prisma.$queryRaw<RateLimitRow[]>`
      SELECT "perSecondLimit", "perDayLimit", "remainingToday", "observedAt", "windowStartMs", "windowCount", "pausedUntil"
      FROM "etsy_rate_limit" WHERE "id" = ${ROW_ID}`;
    return fromRow(rows[0]);
  };
  return {
    read,
    async tryAcquire(nowMs, defaultPerSecond) {
      const prisma = await db();
      const second = BigInt(Math.floor(nowMs / 1000) * 1000);
      const now = new Date(nowMs);
      const granted = await prisma.$queryRaw<RateLimitRow[]>`
        INSERT INTO "etsy_rate_limit" ("id", "windowStartMs", "windowCount", "updatedAt")
        VALUES (${ROW_ID}, ${second}, 1, ${now})
        ON CONFLICT ("id") DO UPDATE SET
          "windowCount" = CASE WHEN "etsy_rate_limit"."windowStartMs" < ${second} THEN 1 ELSE "etsy_rate_limit"."windowCount" + 1 END,
          "windowStartMs" = GREATEST("etsy_rate_limit"."windowStartMs", ${second}),
          "updatedAt" = ${now}
        WHERE ("etsy_rate_limit"."pausedUntil" IS NULL OR "etsy_rate_limit"."pausedUntil" <= ${now})
          AND ("etsy_rate_limit"."windowStartMs" < ${second}
            OR "etsy_rate_limit"."windowCount" < COALESCE("etsy_rate_limit"."perSecondLimit", ${defaultPerSecond}))
        RETURNING "perSecondLimit", "perDayLimit", "remainingToday", "observedAt", "windowStartMs", "windowCount", "pausedUntil"`;
      if (granted.length > 0) return { granted: true, state: fromRow(granted[0]) };
      return { granted: false, state: await read() };
    },
    async observe(o) {
      const prisma = await db();
      const observedAt = new Date(o.observedAtMs);
      await prisma.$executeRaw`
        UPDATE "etsy_rate_limit" SET
          "perSecondLimit" = COALESCE(${o.perSecondLimit}::int, "perSecondLimit"),
          "perDayLimit" = COALESCE(${o.perDayLimit}::int, "perDayLimit"),
          "remainingToday" = COALESCE(${o.remainingToday}::int, "remainingToday"),
          "observedAt" = CASE WHEN ${o.remainingToday}::int IS NULL THEN "observedAt" ELSE ${observedAt} END,
          "updatedAt" = ${observedAt}
        WHERE "id" = ${ROW_ID}`;
    },
    async pauseUntil(untilMs) {
      const prisma = await db();
      const until = new Date(untilMs);
      await prisma.$executeRaw`
        UPDATE "etsy_rate_limit" SET
          "pausedUntil" = GREATEST(COALESCE("pausedUntil", ${until}), ${until}),
          "updatedAt" = NOW()
        WHERE "id" = ${ROW_ID}`;
    },
  };
}

const clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

let store: EtsyRateLimitStore | null = null;
const getStore = () => (store ??= createPrismaRateLimitStore());

/** Swaps the store and/or clock — for tests. `reset` restores the defaults. */
export function configureEtsyClient(
  overrides: { store?: EtsyRateLimitStore; now?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number } | "reset",
): void {
  if (overrides === "reset") {
    store = null;
    clock.now = () => Date.now();
    clock.sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    clock.random = () => Math.random();
    return;
  }
  if (overrides.store) store = overrides.store;
  if (overrides.now) clock.now = overrides.now;
  if (overrides.sleep) clock.sleep = overrides.sleep;
  if (overrides.random) clock.random = overrides.random;
}

export interface EtsyCallContext {
  userId?: string | null;
  priority?: EtsyPriority;
  /** Authenticates `etsyFetch` without a session cookie (the scheduled runner). */
  accessToken?: string;
}

const callContext = new AsyncLocalStorage<EtsyCallContext>();

/** Runs `fn` with every Etsy call inside it attributed to `context` (merged over any outer one). */
export function withEtsyContext<T>(context: EtsyCallContext, fn: () => Promise<T>): Promise<T> {
  return callContext.run({ ...callContext.getStore(), ...context }, fn);
}

export function currentEtsyContext(): EtsyCallContext {
  return callContext.getStore() ?? {};
}

/** When a request of `priority` may start again, or `null` if the daily budget allows it now. */
export function dailyBudgetRetryAt(state: RateLimitState, priority: EtsyPriority, nowMs: number): Date | null {
  const { perDayLimit, remainingToday, observedAtMs } = state;
  if (priority === "critical" || perDayLimit == null || remainingToday == null || observedAtMs == null) return null;
  if (nowMs - observedAtMs >= DAILY_RECHECK_MS) return null;
  const reserve = Math.ceil(perDayLimit * DAILY_RESERVE[priority]);
  if (remainingToday > reserve) return null;
  return new Date(observedAtMs + DAILY_RECHECK_MS);
}

function endpoint(method: string, url: string): string {
  try {
    return `${method} ${new URL(url).pathname}`;
  } catch {
    return `${method} ${url}`;
  }
}

function log(level: "warn" | "error", what: string, ep: string, userId: string | null | undefined, detail: string) {
  console[level](`[etsy] ${what} ${ep} user=${userId ?? "-"} ${detail}`);
}

/**
 * Refuses up front when the daily budget can't cover new work of `priority` —
 * for jobs that make many calls (sync, bulk writes, the runner), so they don't
 * start and then fail halfway.
 */
export async function assertEtsyBudget(priority: EtsyPriority = currentEtsyContext().priority ?? "interactive"): Promise<void> {
  const nowMs = clock.now();
  const state = await getStore().read();
  const retryAt = dailyBudgetRetryAt(state, priority, nowMs);
  if (retryAt) {
    log("warn", "give-up", "(new work)", currentEtsyContext().userId, `daily budget: ${state.remainingToday}/${state.perDayLimit} left, ${priority} work refused until ${retryAt.toISOString()}`);
    throw new EtsyLimitError(retryAt);
  }
}

/** {@link assertEtsyBudget} as a value: the error to report, or `null` when the work may start. */
export async function etsyBudgetError(priority: EtsyPriority): Promise<EtsyLimitError | null> {
  try {
    await assertEtsyBudget(priority);
    return null;
  } catch (err) {
    if (err instanceof EtsyLimitError) return err;
    throw err;
  }
}

/** Waits for a request slot under the shared per-second limit, or throws once the daily budget or a long pause says stop. */
async function acquireSlot(ep: string, priority: EtsyPriority, userId: string | null | undefined): Promise<void> {
  for (;;) {
    const nowMs = clock.now();
    const { granted, state } = await getStore().tryAcquire(nowMs, DEFAULT_PER_SECOND);
    const retryAt = dailyBudgetRetryAt(state, priority, nowMs);
    if (retryAt) {
      log("warn", "give-up", ep, userId, `daily budget: ${state.remainingToday}/${state.perDayLimit} left, ${priority} request refused until ${retryAt.toISOString()}`);
      throw new EtsyLimitError(retryAt);
    }
    if (granted) return;

    const paused = state.pausedUntilMs != null && state.pausedUntilMs > nowMs;
    const waitMs = paused
      ? (state.pausedUntilMs as number) - nowMs
      : Math.floor(nowMs / 1000) * 1000 + 1000 - nowMs + Math.floor(clock.random() * 50);
    if (waitMs > MAX_IN_REQUEST_WAIT_MS) {
      log("warn", "give-up", ep, userId, `paused for ${Math.round(waitMs / 1000)}s — too long to hold the request`);
      throw new EtsyLimitError(new Date(nowMs + waitMs));
    }
    log(
      "warn",
      "throttle",
      ep,
      userId,
      paused
        ? `waiting ${waitMs}ms (paused after a rate-limit response)`
        : `waiting ${waitMs}ms (${state.windowCount}/${state.perSecondLimit ?? DEFAULT_PER_SECOND} requests this second)`,
    );
    await clock.sleep(waitMs);
  }
}

async function observeResponse(res: Response): Promise<RateLimitHeaders> {
  const h = parseRateLimitHeaders(res.headers);
  const nowMs = clock.now();
  if (h.perSecondLimit != null || h.perDayLimit != null || h.remainingToday != null) {
    await getStore().observe({
      perSecondLimit: h.perSecondLimit,
      perDayLimit: h.perDayLimit,
      remainingToday: h.remainingToday,
      observedAtMs: nowMs,
    });
  }
  if (h.remainingThisSecond === 0) await getStore().pauseUntil(Math.floor(nowMs / 1000) * 1000 + 1000);
  return h;
}

export interface EtsyRequestOptions {
  priority?: EtsyPriority;
  userId?: string | null;
}

/**
 * `fetch` to Etsy, through the shared limiter, with retries. Resolves with
 * Etsy's response for anything but a 429 that outlasted its retries (thrown as
 * {@link EtsyLimitError}) or a network error that did (rethrown).
 */
export async function etsyRequest(url: string, init: RequestInit = {}, options: EtsyRequestOptions = {}): Promise<Response> {
  const ctx = currentEtsyContext();
  const priority = options.priority ?? ctx.priority ?? "interactive";
  const userId = options.userId !== undefined ? options.userId : (ctx.userId ?? null);
  const method = (init.method ?? "GET").toUpperCase();
  const ep = endpoint(method, url);
  const retrySafe = RETRY_SAFE_METHODS.has(method);

  let rateLimitRetries = 0;
  let serverRetries = 0;
  for (;;) {
    await acquireSlot(ep, priority, userId);

    let res: Response;
    try {
      res = await fetch(url, { ...init, cache: "no-store" });
    } catch (err) {
      if (!retrySafe || serverRetries >= MAX_SERVER_RETRIES) {
        log("error", "give-up", ep, userId, `network error after ${serverRetries} retries: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      const delay = retryDelayMs(null, serverRetries);
      serverRetries++;
      log("warn", "retry", ep, userId, `network error — retrying in ${delay}ms (${serverRetries}/${MAX_SERVER_RETRIES}): ${err instanceof Error ? err.message : String(err)}`);
      await clock.sleep(delay);
      continue;
    }

    await observeResponse(res);

    if (res.status === 429) {
      const delay = retryDelayMs(res.headers, rateLimitRetries);
      const retryAt = clock.now() + delay;
      await getStore().pauseUntil(retryAt);
      if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES || delay > MAX_IN_REQUEST_WAIT_MS) {
        log("error", "give-up", ep, userId, `429 after ${rateLimitRetries} retries (Retry-After ${res.headers.get("retry-after") ?? "none"})`);
        throw new EtsyLimitError(new Date(retryAt));
      }
      rateLimitRetries++;
      log("warn", "retry", ep, userId, `429 — retrying in ${Math.round(delay)}ms (${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES})`);
      await clock.sleep(delay);
      continue;
    }

    if (res.status >= 500 && retrySafe && serverRetries < MAX_SERVER_RETRIES) {
      const delay = retryDelayMs(null, serverRetries);
      serverRetries++;
      log("warn", "retry", ep, userId, `${res.status} — retrying in ${delay}ms (${serverRetries}/${MAX_SERVER_RETRIES})`);
      await res.body?.cancel().catch(() => {});
      await clock.sleep(delay);
      continue;
    }
    if (res.status >= 500) {
      log("error", "give-up", ep, userId, retrySafe ? `${res.status} after ${serverRetries} retries` : `${res.status} (a ${method} isn't retried)`);
    }
    return res;
  }
}
