import type { Metadata } from "next";
import ScheduleBoard from "./ScheduleBoard";

export const metadata: Metadata = { title: "Schedule" };

/** `/schedule` — the signed-in user's scheduled listings for their active shop, two weeks at a time. */
export default function SchedulePage() {
  return <ScheduleBoard />;
}
