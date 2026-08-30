import { useEffect } from "react";

export type StreamEventType =
  | "hello"
  | "snapshot.required"
  | "task.created"
  | "task.updated"
  | "task.queue.updated"
  | "task.completed"
  | "approval.created"
  | "approval.resolved"
  | "command.updated"
  | "action.updated"
  | "message.received"
  | "message.attributed"
  | "conversation.updated"
  | "agent.health";

export interface StreamEvent {
  type: StreamEventType;
  taskId: string | null;
  data: Record<string, unknown>;
}

const NAMED_EVENTS: StreamEventType[] = [
  "hello",
  "snapshot.required",
  "task.created",
  "task.updated",
  "task.queue.updated",
  "task.completed",
  "approval.created",
  "approval.resolved",
  "command.updated",
  "action.updated",
  "message.received",
  "message.attributed",
  "conversation.updated",
  "agent.health",
];

function toStreamEvent(type: StreamEventType, rawData: string): StreamEvent | null {
  let payload: Record<string, unknown> = {};
  if (rawData) {
    try {
      payload = JSON.parse(rawData) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return {
    type,
    taskId: typeof payload.taskId === "string" ? payload.taskId : null,
    data: payload,
  };
}

/**
 * EventSource wiring for /api/v1/events/stream. The browser reconnects and
 * resumes from Last-Event-ID automatically; `snapshot.required` tells the
 * page to reload everything because the server no longer trusts our cursor
 * (docs §8). The server also emits heartbeat comments which EventSource
 * handles silently.
 */
export function useEventStream(onEvent: (event: StreamEvent) => void, enabled = true) {
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const source = new EventSource("/api/v1/events/stream");

    const listeners = NAMED_EVENTS.map((type) => {
      const listener = (event: MessageEvent) => {
        const streamEvent = toStreamEvent(type, event.data);
        if (streamEvent) onEvent(streamEvent);
      };
      source.addEventListener(type, listener as EventListener);
      return { type, listener };
    });

    return () => {
      listeners.forEach(({ type, listener }) => source.removeEventListener(type, listener as EventListener));
      source.close();
    };
  }, [onEvent, enabled]);
}
