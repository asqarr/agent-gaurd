import { pool } from "../../core/db.mjs";

const channel = "agentguard_workspace_activity";
const subscribers = new Map();
let listenerClient = null;
let connectPromise = null;
let reconnectTimer = null;
let reconnectDelayMs = 1000;
let everConnected = false;
let shuttingDown = false;

function notifyWorkspace(workspaceId, event) {
  const listeners = subscribers.get(workspaceId);
  if (!listeners) return;
  for (const listener of listeners) {
    try { listener(event); } catch { /* A disconnected response must not interrupt other subscribers. */ }
  }
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer || subscribers.size === 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureListener().catch((error) => {
      console.error(JSON.stringify({
        level: "error",
        event: "workspace_activity_listener_reconnect_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }));
      reconnectDelayMs = Math.min(30000, reconnectDelayMs * 2);
      scheduleReconnect();
    });
  }, reconnectDelayMs);
  reconnectTimer.unref?.();
}

function handleNotification(message) {
  if (message.channel !== channel) return;
  let payload;
  try { payload = JSON.parse(message.payload); } catch { return; }
  const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : "";
  const eventId = typeof payload.eventId === "string" ? payload.eventId : "";
  if (!workspaceId || !eventId || !subscribers.has(workspaceId)) return;
  // Notifications are wake-ups only. Each stream replays persisted rows in their
  // workspace order, so concurrent commits cannot arrive out of cursor order.
  notifyWorkspace(workspaceId, null);
}

async function ensureListener() {
  if (shuttingDown) throw new Error("Workspace activity listener is shutting down.");
  if (listenerClient) return listenerClient;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const client = await pool.connect();
    let released = false;
    const releaseClient = (destroy = false) => {
      if (released) return;
      released = true;
      if (listenerClient === client) listenerClient = null;
      client.release(destroy);
    };
    client.on("notification", handleNotification);
    client.on("error", (error) => {
      console.error(JSON.stringify({
        level: "error",
        event: "workspace_activity_listener_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }));
      releaseClient(true);
      scheduleReconnect();
    });
    client.on("end", () => {
      releaseClient(true);
      scheduleReconnect();
    });
    try {
      await client.query(`LISTEN ${channel}`);
      listenerClient = client;
      reconnectDelayMs = 1000;
      if (everConnected) {
        for (const workspaceId of subscribers.keys()) notifyWorkspace(workspaceId, null);
      }
      everConnected = true;
      return client;
    } catch (error) {
      releaseClient(true);
      throw error;
    }
  })();

  try {
    return await connectPromise;
  } finally {
    connectPromise = null;
  }
}

export async function subscribeWorkspaceActivity(workspaceId, listener) {
  if (typeof workspaceId !== "string" || !workspaceId || typeof listener !== "function") {
    throw new TypeError("Workspace activity subscription requires a workspace and listener.");
  }
  if (shuttingDown) throw new Error("Workspace activity listener is shutting down.");
  let listeners = subscribers.get(workspaceId);
  if (!listeners) {
    listeners = new Set();
    subscribers.set(workspaceId, listeners);
  }
  listeners.add(listener);
  try {
    await ensureListener();
  } catch (error) {
    listeners.delete(listener);
    if (listeners.size === 0) subscribers.delete(workspaceId);
    throw error;
  }
  return () => {
    const workspaceListeners = subscribers.get(workspaceId);
    if (!workspaceListeners) return;
    workspaceListeners.delete(listener);
    if (workspaceListeners.size === 0) subscribers.delete(workspaceId);
  };
}

export async function stopWorkspaceActivityHub() {
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  subscribers.clear();
  const client = listenerClient;
  listenerClient = null;
  if (!client) return;
  client.removeAllListeners("notification");
  client.removeAllListeners("error");
  client.removeAllListeners("end");
  try { await client.query(`UNLISTEN ${channel}`); } catch { /* Connection may already be gone. */ }
  client.release();
}
