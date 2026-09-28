import {
  NO_REPLY_TOKEN,
  isNoReply,
  type StreamEvent,
} from "@yoplai/shared";

export { NO_REPLY_TOKEN, isNoReply };

function couldBecomeNoReply(text: string): boolean {
  let candidate = text.trimStart().replace(/^[*`]+/, "");
  candidate = candidate.replace(/[*`]+$/, "");
  if (candidate.endsWith(".")) candidate = candidate.slice(0, -1).trimEnd();
  return NO_REPLY_TOKEN.startsWith(candidate) || isNoReply(text);
}

/** Holds ambiguous text chunks independently for each assistant message. */
export function createNoReplyHoldback(emit: (event: StreamEvent) => void) {
  let buffered = "";
  let diverged = false;

  const finishSegment = () => {
    if (buffered && !isNoReply(buffered)) {
      emit({ type: "text", data: buffered });
    }
    buffered = "";
    diverged = false;
  };

  return {
    push(event: StreamEvent): void {
      if (event.type !== "text") {
        // Tool activity separates Pi assistant messages. Container and other
        // adapters expose the same normalized tool events.
        if (event.type.startsWith("tool_")) finishSegment();
        emit(event);
        return;
      }
      if (diverged) {
        emit(event);
        return;
      }

      buffered += event.data;
      if (!couldBecomeNoReply(buffered)) {
        diverged = true;
        emit({ type: "text", data: buffered });
        buffered = "";
      }
    },
    finishSegment,
    flush(): void {
      if (buffered) emit({ type: "text", data: buffered });
      buffered = "";
      diverged = false;
    },
    drop(): void {
      buffered = "";
      diverged = false;
    },
  };
}
