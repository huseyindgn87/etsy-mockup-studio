import { describe, expect, test } from "vitest";
import { orderCandidates, pickNextJob, queuePosition, type QueueEntry } from "../order";

const T = Date.parse("2026-09-18T12:00:00Z");
const entry = (id: string, userId: string, priority: number, minute: number): QueueEntry => ({
  id,
  userId,
  priority,
  createdAt: new Date(T + minute * 60_000),
});

describe("priority order", () => {
  test("a job a user is waiting on beats a scheduled one, which beats background work — whatever their age", () => {
    const candidates = [entry("bg", "u1", 2, 0), entry("sched", "u2", 1, 1), entry("click", "u3", 0, 2)];
    expect(orderCandidates(candidates, new Map()).map((c) => c.id)).toEqual(["click", "sched", "bg"]);
  });
});

describe("fairness between users", () => {
  test("at one priority, the user served longest ago goes first, even with a newer job", () => {
    const served = new Map([
      ["heavy", T + 5_000],
      ["light", T - 60_000],
    ]);
    const next = pickNextJob([entry("h1", "heavy", 0, 0), entry("l1", "light", 0, 10)], served);
    expect(next?.id).toBe("l1");
  });

  test("a user never served goes before one who has been", () => {
    const next = pickNextJob([entry("h1", "heavy", 0, 0), entry("n1", "new", 0, 10)], new Map([["heavy", T]]));
    expect(next?.id).toBe("n1");
  });

  test("among users never served, the older job goes first", () => {
    expect(pickNextJob([entry("b", "u2", 0, 5), entry("a", "u1", 0, 1)], new Map())?.id).toBe("a");
  });
});

describe("queuePosition", () => {
  test("better-priority jobs and running jobs are all ahead", () => {
    const mine = entry("mine", "me", 1, 10);
    const waiting = [mine, entry("x", "u1", 0, 20), entry("y", "u2", 0, 30), entry("z", "u3", 2, 0)];
    expect(queuePosition(mine, waiting, 2, new Map())).toBe(1 + 2 + 2);
  });

  test("round-robin: a newcomer behind a user with 5,000 queued jobs waits one turn, not 5,000", () => {
    const heavy = Array.from({ length: 5000 }, (_, i) => entry(`h${i}`, "heavy", 0, i / 1000));
    const mine = entry("mine", "me", 0, 60);
    const served = new Map([["heavy", T]]);
    expect(queuePosition(mine, [...heavy, mine], 0, served)).toBe(1);
    // …and 2nd if the heavy user's turn comes first.
    expect(queuePosition(mine, [...heavy, mine], 0, new Map([["me", T + 1]]))).toBe(2);
  });

  test("my third job waits for my first two and two turns of every other user", () => {
    const mine = [entry("m0", "me", 0, 10), entry("m1", "me", 0, 11), entry("m2", "me", 0, 12)];
    const other = Array.from({ length: 10 }, (_, i) => entry(`o${i}`, "other", 0, 20 + i));
    const third = mine[2];
    // other's oldest is newer than mine, so my turn comes first: 2 of mine + 2 of theirs ahead.
    expect(queuePosition(third, [...mine, ...other], 0, new Map())).toBe(5);
  });
});
