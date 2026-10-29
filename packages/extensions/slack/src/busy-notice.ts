import type { ExtensionContext } from "@yoplai/shared";

type ActiveRun = Awaited<ReturnType<NonNullable<ExtensionContext["getActiveRun"]>>>;
type BusyNotice = { kind: "reply"; text: string } | { kind: "react" };

/** One acknowledgement per conversation/run, with bounded process-local memory. */
export function createBusyNoticePolicy() {
  const notified = new Map<string, number | null>();
  return (conversation: string, run: ActiveRun, canCancel = true, now = Date.now()): BusyNotice => {
    const identity = run?.startedAt ?? null;
    if (notified.has(conversation) && notified.get(conversation) === identity) {
      return { kind: "react" };
    }
    notified.delete(conversation);
    notified.set(conversation, identity);
    if (notified.size > 3000) notified.delete(notified.keys().next().value!);

    let text = "I'm busy";
    if (run?.taskTitle) {
      const title = (run.taskTitle.length > 200 ? `${run.taskTitle.slice(0, 200)}…` : run.taskTitle)
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      text += ` working on “${title}”`;
    }
    if (run) {
      const seconds = Math.max(0, Math.floor((now - run.startedAt) / 1000));
      const [amount, unit] = seconds >= 3600
        ? [Math.floor(seconds / 3600), "hour"]
        : seconds >= 60 ? [Math.floor(seconds / 60), "minute"] : [seconds, "second"];
      text += ` (running for ${amount} ${unit}${amount === 1 ? "" : "s"})`;
    }
    text += ". Your message is queued.";
    if (canCancel) text += " Send `!stop` to cancel.";
    return { kind: "reply", text };
  };
}
