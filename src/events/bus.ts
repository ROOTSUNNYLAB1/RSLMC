import type { WsMessage } from "../shared/types";

type Listener = (message: WsMessage) => void;

/**
 * Tiny in-process pub/sub used to fan out console lines, metrics and status changes
 * to authenticated WebSocket clients. Topics are `server:<id>` or `user:<id>`.
 */
class EventBus {
  private topics = new Map<string, Set<Listener>>();

  subscribe(topic: string, listener: Listener): () => void {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.topics.delete(topic);
    };
  }

  publish(topic: string, message: WsMessage): void {
    const set = this.topics.get(topic);
    if (!set) return;
    for (const listener of set) {
      try { listener(message); } catch (err) { console.error("[rslmc] listener error", err); }
    }
  }

  counts(): { topics: number; listeners: number } {
    let listeners = 0;
    for (const set of this.topics.values()) listeners += set.size;
    return { topics: this.topics.size, listeners };
  }
}

export const bus = new EventBus();
export const serverTopic = (id: number) => `server:${id}`;
export const userTopic = (id: number) => `user:${id}`;
