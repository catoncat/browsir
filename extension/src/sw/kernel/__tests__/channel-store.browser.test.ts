import "./test-setup";

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetIdbStorageForTest,
  clearIdbStores,
  getDB,
} from "../idb-storage";
import { ChannelStore } from "../channel-store";
import {
  buildChannelBindingKey,
  buildChannelConversationKey,
  buildRemoteMessageKey,
  type ChannelBindingRecord,
  type ChannelEventRecord,
  type ChannelOutboxRecord,
  type ChannelProjectionOutcome,
  type ChannelReplyProjection,
  type ChannelTurnRecord,
} from "../channel-types";

const DB_NAME = "browser-brain-loop";

function createLegacyDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "header.id" });
      }
      if (!db.objectStoreNames.contains("entries")) {
        const entries = db.createObjectStore("entries", { keyPath: "id" });
        entries.createIndex("by-session", "sessionId");
      }
      if (!db.objectStoreNames.contains("traces")) {
        const traces = db.createObjectStore("traces", { keyPath: "id" });
        traces.createIndex("by-trace", "traceId");
      }
      if (!db.objectStoreNames.contains("kv")) {
        db.createObjectStore("kv");
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
}

function createBinding(): ChannelBindingRecord {
  return {
    bindingKey: buildChannelBindingKey("wechat", "conv-1"),
    channelConversationKey: buildChannelConversationKey("wechat", "conv-1"),
    channelKind: "wechat",
    remoteConversationId: "conv-1",
    remoteUserId: "user-1",
    sessionId: "session-1",
    trustTier: "external_remote",
    sourceLabel: "wechat",
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-22T00:00:00.000Z",
  };
}

function createTurn(): ChannelTurnRecord {
  return {
    channelTurnId: "turn-1",
    bindingKey: buildChannelBindingKey("wechat", "conv-1"),
    remoteMessageKey: buildRemoteMessageKey("wechat", "conv-1", "msg-1"),
    channelKind: "wechat",
    remoteConversationId: "conv-1",
    remoteUserId: "user-1",
    remoteMessageId: "msg-1",
    sessionId: "session-1",
    queuedMode: "start",
    lifecycleStatus: "received",
    dispatchStatus: "pending",
    deliveryStatus: "not_requested",
    interventionStatus: "none",
    repairStatus: "none",
    anomalyFlags: [],
    runAttemptCount: 0,
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-22T00:00:00.000Z",
  };
}

function createEvent(): ChannelEventRecord {
  return {
    eventId: "event-1",
    channelTurnId: "turn-1",
    sessionId: "session-1",
    type: "channel.turn.accepted",
    createdAt: "2026-03-22T00:00:00.000Z",
    payload: { accepted: true },
  };
}

function createProjection(): ChannelProjectionOutcome {
  return {
    channelTurnId: "turn-1",
    sessionId: "session-1",
    assistantEntryId: "assistant-1",
    projectionKind: "final_text",
    visibleText: "done",
    truncated: false,
    trustTier: "external_remote",
  };
}

function createReplyProjection(): ChannelReplyProjection {
  return {
    channelTurnId: "turn-1",
    deliveryId: "delivery-1",
    parts: [{ kind: "text", text: "done" }],
  };
}

function createOutbox(): ChannelOutboxRecord {
  return {
    deliveryId: "delivery-1",
    channelTurnId: "turn-1",
    sessionId: "session-1",
    channelKind: "wechat",
    projectionKind: "final_text",
    deliveryStatus: "queued",
    attemptCount: 0,
    projection: createProjection(),
    replyProjection: createReplyProjection(),
    createdAt: "2026-03-22T00:00:01.000Z",
    updatedAt: "2026-03-22T00:00:01.000Z",
  };
}

beforeEach(async () => {
  await __resetIdbStorageForTest();
});

describe("channel-store.browser", () => {
  it("migrates v2 database to v3 without losing existing stores", async () => {
    await createLegacyDb();
    const db = await getDB();

    expect(db.version).toBe(3);
    expect(db.objectStoreNames.contains("sessions")).toBe(true);
    expect(db.objectStoreNames.contains("entries")).toBe(true);
    expect(db.objectStoreNames.contains("traces")).toBe(true);
    expect(db.objectStoreNames.contains("kv")).toBe(true);
    expect(db.objectStoreNames.contains("channelBindings")).toBe(true);
    expect(db.objectStoreNames.contains("channelTurns")).toBe(true);
    expect(db.objectStoreNames.contains("channelEvents")).toBe(true);
    expect(db.objectStoreNames.contains("channelOutbox")).toBe(true);
  });

  it("atomically accepts inbound binding, turn, and event", async () => {
    const store = new ChannelStore();
    await clearIdbStores();

    const binding = createBinding();
    const turn = createTurn();
    const event = createEvent();

    await store.acceptInbound({
      binding,
      turn,
      initialEvent: event,
    });

    await expect(store.getBinding("wechat", "conv-1")).resolves.toEqual(binding);
    await expect(store.getBindingBySessionId("session-1")).resolves.toEqual(
      binding,
    );
    await expect(store.getTurn("turn-1")).resolves.toEqual(turn);
    await expect(
      store.getTurnByRemoteMessage("wechat", "conv-1", "msg-1"),
    ).resolves.toEqual(turn);
    await expect(store.listEventsForTurn("turn-1")).resolves.toEqual([event]);
  });

  it("stores and queries outbox records by turn", async () => {
    const store = new ChannelStore();
    await clearIdbStores();

    const binding = createBinding();
    const turn = createTurn();
    await store.acceptInbound({
      binding,
      turn,
      initialEvent: null,
    });

    const outbox = createOutbox();
    await store.putOutbox(outbox);

    await expect(store.getOutboxRecord("delivery-1")).resolves.toEqual(outbox);
    await expect(store.listOutboxByTurn("turn-1")).resolves.toEqual([outbox]);
    await expect(store.listTurnsBySession("session-1")).resolves.toEqual([turn]);
  });
});
