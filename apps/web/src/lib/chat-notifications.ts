import { createSignal } from "solid-js";
import type { SessionSummary } from "../api/types";
import { capabilities } from "./capabilities";

const [revision, setRevision] = createSignal(0);
const changed = () => setRevision((value) => value + 1);
const markers = new Map<
  string,
  NonNullable<SessionSummary["lastWebCompletion"]>
>();
const viewed = new Map<symbol, string>();
const liveDuringBaseline = new Set<string>();
const markerTimes = new Map<string, number>();
const failedWrites = new Map<string, string>();
const user = () =>
  capabilities.multiUser ? (capabilities.user?.id ?? "") : "local";
const chatKey = (agentId: string, sessionId: string) =>
  `${user()}:${agentId}:${sessionId}`;
const readKey = (key: string) => `yoplai:chat-read:${key}`;
const initKey = () => `yoplai:chat-read-init:${user()}`;
const read = (key: string) => {
  if (failedWrites.has(key)) return failedWrites.get(key)!;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
    failedWrites.delete(key);
  } catch {
    failedWrites.set(key, value);
  }
  changed();
}
function isViewing(key: string) {
  return (
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    [...viewed.values()].includes(key)
  );
}
function readViewed() {
  for (const key of viewed.values()) {
    const marker = markers.get(key);
    const current = read(readKey(key));
    if (
      marker &&
      isViewing(key) &&
      (!current || (markerTimes.get(current) ?? Infinity) <= marker.endedAt)
    )
      write(readKey(key), marker.id);
  }
  changed();
}
window.addEventListener("storage", (event) => {
  if (event.key) failedWrites.delete(event.key);
  else failedWrites.clear();
  changed();
});
window.addEventListener("focus", readViewed);
window.addEventListener("blur", changed);
document.addEventListener("visibilitychange", readViewed);

export function notificationSoundEnabled() {
  revision();
  return read("yoplai:notify-sound") !== "off";
}
export function toggleNotificationSound() {
  write("yoplai:notify-sound", notificationSoundEnabled() ? "off" : "on");
}
export function registerViewedChat(agentId: string, sessionId: string) {
  const token = Symbol();
  viewed.set(token, chatKey(agentId, sessionId));
  readViewed();
  return () => {
    viewed.delete(token);
    changed();
  };
}
export function captureChatReads() {
  const snapshot = new Map<string, string | null>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(`yoplai:chat-read:${user()}:`))
        snapshot.set(key, read(key));
    }
  } catch {
    /* Storage is optional. */
  }
  return { reads: snapshot, markers: new Map(markers) };
}
export function observeChatSessions(
  sessions: SessionSummary[],
  readsAtStart?: ReturnType<typeof captureChatReads>
) {
  for (const session of sessions) {
    if (session.archived || !session.lastWebCompletion) continue;
    const key = chatKey(session.agentId, session.sessionId);
    const previous = markers.get(key);
    const marker = session.lastWebCompletion;
    const unseen = !markerTimes.has(marker.id);
    markerTimes.set(marker.id, marker.endedAt);
    if (
      !previous ||
      previous.endedAt < marker.endedAt ||
      (previous.endedAt === marker.endedAt &&
        unseen &&
        (!readsAtStart || readsAtStart.markers.get(key)?.id === previous.id))
    )
      markers.set(key, marker);
    const currentRead = read(readKey(key));
    // A response requested after this read was stored can establish its order.
    // A response already in flight when another tab read cannot do so.
    if (
      currentRead &&
      readsAtStart &&
      (readsAtStart.reads.get(readKey(key)) ?? null) === currentRead &&
      !markerTimes.has(currentRead)
    ) {
      markerTimes.set(
        currentRead,
        marker.id === currentRead ? marker.endedAt : marker.endedAt - 1
      );
    }
  }
  if (!read(initKey())) {
    for (const session of sessions) {
      const key = readKey(chatKey(session.agentId, session.sessionId));
      if (
        session.lastWebCompletion &&
        !liveDuringBaseline.has(session.lastWebCompletion.id) &&
        !read(key)
      )
        write(key, session.lastWebCompletion.id);
    }
    write(initKey(), "1");
  }
  readViewed();
}
export function bufferChatCompletion(id: string) {
  if (!read(initKey())) liveDuringBaseline.add(id);
}
export function isChatUnread(session: SessionSummary) {
  revision();
  const key = chatKey(session.agentId, session.sessionId);
  const marker = markers.get(key) ?? session.lastWebCompletion;
  const current = read(readKey(key));
  return Boolean(
    read(initKey()) &&
    marker &&
    marker.id !== current &&
    (!current || (markerTimes.get(current) ?? Infinity) <= marker.endedAt) &&
    !isViewing(key)
  );
}
export function acceptChatCompletion(session: SessionSummary) {
  const marker = session.lastWebCompletion!;
  const unseen = !markerTimes.has(marker.id);
  const current = read(readKey(chatKey(session.agentId, session.sessionId)));
  observeChatSessions([session]);
  window.dispatchEvent(new Event("chat-projects-changed"));
  return unseen && Boolean(current && !markerTimes.has(current));
}

export function playCompletionSound(
  completionId: string,
  active: () => boolean
) {
  const key = `yoplai:notify-claim:${completionId}`;
  const play = () => {
    if (!active() || !notificationSoundEnabled()) return;
    try {
      const audio = new Audio(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/notify.mp3`);
      audio.volume = 0.6;
      void audio.play()?.catch(() => undefined);
    } catch {
      /* Autoplay and unavailable audio must not affect chat. */
    }
  };
  const claim = () => {
    if (!active()) return false;
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const candidate = localStorage.key(i);
        if (!candidate?.startsWith("yoplai:notify-claim:")) continue;
        const value = read(candidate);
        const at = value ? Number(JSON.parse(value).at) : 0;
        if (!Number.isFinite(at) || at < Date.now() - 300_000)
          localStorage.removeItem(candidate);
      }
      if (read(key)) return false;
      write(key, JSON.stringify({ at: Date.now(), owner: claimId }));
    } catch {
      /* A storage failure permits this tab's best effort attempt. */
    }
    return true;
  };
  const claimId = crypto.randomUUID();
  if (navigator.locks?.request) {
    void navigator.locks
      .request(key, claim)
      .then((won) => {
        if (won) play();
      })
      .catch(() => undefined);
  } else if (claim()) {
    setTimeout(() => {
      const value = read(key);
      if (!value || value.includes(claimId)) play();
    }, 150);
  }
}
