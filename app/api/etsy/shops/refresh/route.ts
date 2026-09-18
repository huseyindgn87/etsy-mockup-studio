import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { getEtsySession, sessionCookieOptions } from "@/lib/etsy/auth";
import { prisma } from "@/lib/db/prisma";
import { etsyBudgetError } from "@/lib/etsy/client";
import { getEtsyConfig } from "@/lib/etsy/config";
import type { RefreshProgressEvent, SyncResult, SyncStage } from "@/lib/etsy/listing-sync";
import { refreshSession } from "@/lib/etsy/oauth";
import { getActiveShopId, getDecryptedRefreshToken, updateConnectionRefreshToken } from "@/lib/etsy/shop-connections";
import { sealSession, SESSION_COOKIE, type EtsySession } from "@/lib/etsy/session";
import { describeJob } from "@/lib/jobs/describe";
import { enqueueJob, toJobView } from "@/lib/jobs/queue";
import { helpUntilFinished } from "@/lib/jobs/run";
import { JOB_PRIORITY, type JobStatus } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** How long the stream follows the job before handing the client its id to poll. */
export const STREAM_FOLLOW_MS = 270_000;
const POLL_MS = 750;

/** The stream's events: the sync's own, plus where the queued job stands. */
export type RefreshStreamEvent =
  | RefreshProgressEvent
  | { type: "queued"; jobId: string; position: number | null; message: string }
  | { type: "pending"; jobId: string; message: string };

/**
 * No explicit return type here on purpose: `TextEncoder#encode` returns
 * `Uint8Array<ArrayBuffer>`, and annotating this as the bare `Uint8Array`
 * (which defaults to `Uint8Array<ArrayBufferLike>`) makes the result
 * un-assignable to `BodyInit`'s `ArrayBufferView<ArrayBuffer>` arm under
 * TS 5.7+'s generic typed arrays.
 */
function encodeEvent(event: RefreshStreamEvent) {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

function errorResponse(message: string, status: number): Response {
  return new Response(encodeEvent({ type: "error", message }), {
    status,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}

/**
 * Refresh the active (or a chosen) shop's listings from Etsy and stream
 * progress back as newline-delimited JSON `RefreshProgressEvent`s — the
 * listings page's refresh modal reads this as it arrives to drive its live
 * status line. `POST { shopId? }`: omit `shopId` to refresh the shop that's
 * currently active in the session; pass a different one (from the modal's
 * "Switch shop" dropdown) to switch to it first, using that connection's
 * stored refresh token — this is how the modal changes shop without the
 * user leaving it or re-authorizing.
 *
 * The refresh itself is a `listing_refresh` job (lib/jobs/handlers/listing-refresh.ts)
 * at the priority of a user who's waiting — one unfinished refresh per shop,
 * so pressing Refresh twice follows the same job. The stream reports where it
 * stands: `queued` (with its place in line) until a worker takes it, the
 * sync's own `status`/`progress` events while it runs, then `done` or
 * `error`. The request itself works the queue meanwhile. If the job is still
 * going after {@link STREAM_FOLLOW_MS}, a `pending` event hands over its id
 * for `GET /api/jobs/[id]`.
 *
 * Strictly read-only against Etsy: the sync only ever issues GET requests.
 */
export async function POST(request: NextRequest) {
  const appSession = await auth();
  if (!appSession?.user?.id) return errorResponse("Not signed in.", 401);
  const userId = appSession.user.id;

  const body = (await request.json().catch(() => ({}))) as { shopId?: unknown };
  const requestedShopId = typeof body.shopId === "string" && body.shopId ? body.shopId : null;

  const etsySession = await getEtsySession();
  let shopId = await getActiveShopId(userId, etsySession?.userId ?? null);

  if (requestedShopId && requestedShopId !== shopId) {
    const storedRefreshToken = await getDecryptedRefreshToken(userId, requestedShopId);
    if (!storedRefreshToken) return errorResponse("That shop isn't connected.", 404);

    try {
      const tokens = await refreshSession(storedRefreshToken);
      const session: EtsySession = { ...tokens, ownerUserId: userId };
      const { sessionSecret } = getEtsyConfig();
      // Written via `cookies()` (not a `NextResponse` we build ourselves) so
      // the switched session is visible to `etsyFetch` for the rest of *this*
      // request — the same pattern `getAccessToken` uses for its own
      // in-request token refresh — while Next still attaches the resulting
      // Set-Cookie to whatever response this handler returns.
      (await cookies()).set(SESSION_COOKIE, sealSession(session, sessionSecret), sessionCookieOptions());
      await updateConnectionRefreshToken(userId, requestedShopId, tokens.refreshToken);
      shopId = requestedShopId;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to switch shop.";
      return errorResponse(message, 502);
    }
  }

  if (!shopId) return errorResponse("Not connected to Etsy.", 401);
  const activeShopId = shopId;

  const limited = await etsyBudgetError("interactive");
  if (limited) return errorResponse(limited.message, 429);

  const job = await enqueueJob({
    userId,
    shopId: activeShopId,
    type: "listing_refresh",
    payload: { shopId: activeShopId },
    priority: JOB_PRIORITY.interactive,
    activeKey: `refresh:${userId}:${activeShopId}`,
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: RefreshStreamEvent) => controller.enqueue(encodeEvent(event));
      const deadline = Date.now() + STREAM_FOLLOW_MS;
      // Work the queue while following the job; when there's nothing this
      // request can claim (another worker has it, or it's waiting its turn)
      // look again at the next poll.
      let working = false;
      let helping: Promise<unknown> = Promise.resolve();
      const help = () => {
        working = true;
        helping = helpUntilFinished(job.id, Math.max(0, deadline - Date.now()))
          .catch((err) => console.error(`[jobs] refresh ${job.id} worker pass failed`, err))
          .finally(() => {
            working = false;
          });
      };
      let last = "";
      try {
        for (;;) {
          const row = await prisma.etsyJob.findUnique({ where: { id: job.id } });
          if (!row) throw new Error("The refresh job disappeared.");
          const status = row.status as JobStatus;
          if (status === "done") {
            emit({ type: "done", ...(row.result as unknown as SyncResult) });
            break;
          }
          if (status === "failed") {
            emit({ type: "error", message: row.error || "Refresh failed." });
            break;
          }
          const event = await eventFor(row);
          const key = JSON.stringify(event);
          if (key !== last) emit(event);
          last = key;
          if (Date.now() >= deadline) {
            emit({ type: "pending", jobId: job.id, message: "Still refreshing — this continues in the background." });
            break;
          }
          if (!working) help();
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : "Refresh failed." });
      } finally {
        controller.close();
        await helping;
      }
    },
  });

  return new NextResponse(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}

async function eventFor(row: Parameters<typeof toJobView>[0]): Promise<RefreshStreamEvent> {
  const view = await toJobView(row);
  if (view.status !== "running") {
    return { type: "queued", jobId: row.id, position: view.position, message: describeJob(view) };
  }
  const p = (row.progress ?? {}) as { stage?: SyncStage | null; message?: string; done?: number | null; total?: number | null };
  const stage = p.stage ?? undefined;
  if (stage && p.done != null && p.total != null) {
    return { type: "progress", stage, fetched: p.done, total: p.total, message: p.message ?? "" };
  }
  return { type: "status", stage, message: p.message ?? "Refreshing" };
}
