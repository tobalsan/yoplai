import type { FeedWindow } from "@yoplai/shared";
import type { RoomStore } from "./store.js";

export function watchRoomFeed(
  rooms: RoomStore, roomId: string, userId: string, limit: number, signal: AbortSignal,
  publish: (window: FeedWindow, snapshot: boolean) => void, forbid: () => void,
): Promise<"forbidden" | "unavailable"> {
  if (!rooms.mayAccess(roomId, userId)) return Promise.resolve("forbidden");
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      unsubscribe();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      resolve("unavailable");
    };
    const publishWindow = (snapshot: boolean) => {
      try {
        publish(rooms.window(roomId, limit), snapshot);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const unsubscribe = rooms.onEvent((event) => {
      if (event.roomId !== roomId) return;
      if (event.type === "roomDeleted" || (event.type === "memberRemoved" && event.userId === userId)) {
        forbid();
      } else if (event.type === "appended") {
        publishWindow(false);
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    publishWindow(true);
  });
}
