import { useCallback, useEffect, useRef, useState } from "react";
import { getWorkspaceActivity } from "./activity.api";
import type { WorkspaceActivity } from "../../shared/types/api";

export type ActivityConnection = "disconnected" | "connecting" | "live" | "reconnecting";

function compareIdsDescending(left: WorkspaceActivity, right: WorkspaceActivity) {
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  return leftId > rightId ? -1 : leftId < rightId ? 1 : 0;
}

function mergeEvents(current: WorkspaceActivity[], incoming: WorkspaceActivity[]) {
  const byId = new Map<string, WorkspaceActivity>();
  for (const event of current) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort(compareIdsDescending).slice(0, 250);
}

export function useWorkspaceActivity(workspaceId: string | null, isVisible: boolean) {
  const [events, setEvents] = useState<WorkspaceActivity[]>([]);
  const [connection, setConnection] = useState<ActivityConnection>("disconnected");
  const [unreadCount, setUnreadCount] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyNotice, setHistoryNotice] = useState("");
  const seenIds = useRef(new Set<string>());
  const viewingRef = useRef(isVisible);

  useEffect(() => {
    viewingRef.current = isVisible;
    if (isVisible) setUnreadCount(0);
  }, [isVisible]);

  useEffect(() => {
    seenIds.current.clear();
    setEvents([]);
    setUnreadCount(0);
    setHasMore(true);
    setHistoryNotice("");
    if (!workspaceId) {
      setConnection("disconnected");
      return;
    }

    let active = true;
    setConnection("connecting");
    const stream = new EventSource("/api/activity/stream", { withCredentials: true });
    stream.onopen = () => {
      if (active) setConnection("live");
    };
    stream.onerror = () => {
      if (active) setConnection("reconnecting");
    };

    const acceptEvent = (message: MessageEvent<string>, countAsUnread: boolean) => {
      let event: WorkspaceActivity;
      try { event = JSON.parse(message.data) as WorkspaceActivity; } catch { return; }
      if (!event?.id || !event.type || seenIds.current.has(event.id)) return;
      seenIds.current.add(event.id);
      setEvents((current) => mergeEvents(current, [event]));
      if (countAsUnread && !viewingRef.current) setUnreadCount((current) => Math.min(99, current + 1));
    };
    void getWorkspaceActivity({ limit: 50 })
      .then((result) => {
        if (!active) return;
        const unseen = result.events.filter((event) => {
          if (seenIds.current.has(event.id)) return false;
          seenIds.current.add(event.id);
          return true;
        });
        setEvents((current) => mergeEvents(current, unseen));
        setHasMore(result.hasMore);
      })
      .catch(() => {});

    const handleActivity = (event: Event) => acceptEvent(event as MessageEvent<string>, true);
    const handleHistory = (event: Event) => {
      acceptEvent(event as MessageEvent<string>, false);
    };
    const handleGap = (event: Event) => {
      const message = event as MessageEvent<string>;
      try {
        const payload = JSON.parse(message.data) as { message?: string };
        if (payload.message) setHistoryNotice(payload.message);
      } catch { /* Ignore malformed server events. */ }
    };
    stream.addEventListener("activity", handleActivity);
    stream.addEventListener("activity-history", handleHistory);
    stream.addEventListener("history-gap", handleGap);
    stream.addEventListener("stream-close", () => {
      if (active) setConnection("reconnecting");
    });

    return () => {
      active = false;
      stream.close();
      setConnection("disconnected");
    };
  }, [workspaceId]);

  const loadOlder = useCallback(async () => {
    const beforeId = events[events.length - 1]?.id;
    if (!beforeId || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    try {
      const result = await getWorkspaceActivity({ beforeId, limit: 50 });
      for (const event of result.events) seenIds.current.add(event.id);
      setEvents((current) => mergeEvents(current, result.events));
      setHasMore(result.hasMore);
      if (!result.events.length) setHasMore(false);
    } catch {
      setHistoryNotice("Older activity could not be loaded. The live stream is still active.");
    } finally {
      setLoadingOlder(false);
    }
  }, [events, hasMore, loadingOlder]);

  return { events, connection, unreadCount, hasMore, loadingOlder, historyNotice, loadOlder };
}
