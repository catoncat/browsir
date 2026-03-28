import { getDB } from "./idb-storage";
import type {
  ChannelBindingRecord,
  ChannelDeliveryStatus,
  ChannelEventRecord,
  ChannelOutboxRecord,
  ChannelTurnRecord,
  ChannelKind,
} from "./channel-types";
import {
  buildChannelBindingKey,
  buildChannelConversationKey,
  buildRemoteMessageKey,
} from "./channel-types";

type ChannelWritableStoreName =
  | "channelBindings"
  | "channelTurns"
  | "channelEvents"
  | "channelOutbox";

const CHANNEL_STORE_NAMES = [
  "channelBindings",
  "channelTurns",
  "channelEvents",
  "channelOutbox",
] as const satisfies readonly ChannelWritableStoreName[];

export interface ChannelInboundAcceptanceRecord {
  binding: ChannelBindingRecord;
  turn: ChannelTurnRecord;
  initialEvent?: ChannelEventRecord | null;
}

export interface ChannelInboundDuplicateRecord {
  binding: ChannelBindingRecord | null;
  turn: ChannelTurnRecord | null;
}

export class ChannelStore {
  async acceptInbound(
    record: ChannelInboundAcceptanceRecord,
  ): Promise<void> {
    const db = await getDB();
    const tx = db.transaction([...CHANNEL_STORE_NAMES], "readwrite");
    await tx.objectStore("channelBindings").put(record.binding);
    await tx.objectStore("channelTurns").put(record.turn);
    if (record.initialEvent) {
      await tx.objectStore("channelEvents").put(record.initialEvent);
    }
    await tx.done;
  }

  async getBinding(
    channelKind: ChannelKind,
    remoteConversationId: string,
  ): Promise<ChannelBindingRecord | null> {
    const db = await getDB();
    const key = buildChannelBindingKey(channelKind, remoteConversationId);
    return (await db.get("channelBindings", key)) ?? null;
  }

  async getBindingBySessionId(
    sessionId: string,
  ): Promise<ChannelBindingRecord | null> {
    const db = await getDB();
    const index = db
      .transaction("channelBindings")
      .objectStore("channelBindings")
      .index("by-session");
    const result = await index.get(sessionId);
    return result ?? null;
  }

  async getTurn(channelTurnId: string): Promise<ChannelTurnRecord | null> {
    const db = await getDB();
    return (await db.get("channelTurns", channelTurnId)) ?? null;
  }

  async putTurn(record: ChannelTurnRecord): Promise<void> {
    const db = await getDB();
    await db.put("channelTurns", record);
  }

  async getTurnByRemoteMessage(
    channelKind: ChannelKind,
    remoteConversationId: string,
    remoteMessageId: string,
  ): Promise<ChannelTurnRecord | null> {
    const db = await getDB();
    const index = db
      .transaction("channelTurns")
      .objectStore("channelTurns")
      .index("by-remote-message");
    const result = await index.get(
      buildRemoteMessageKey(channelKind, remoteConversationId, remoteMessageId),
    );
    return result ?? null;
  }

  async listTurnsBySession(sessionId: string): Promise<ChannelTurnRecord[]> {
    const db = await getDB();
    const index = db
      .transaction("channelTurns")
      .objectStore("channelTurns")
      .index("by-session");
    return (await index.getAll(sessionId)) as ChannelTurnRecord[];
  }

  async appendEvent(record: ChannelEventRecord): Promise<void> {
    const db = await getDB();
    await db.put("channelEvents", record);
  }

  async listEventsForTurn(channelTurnId: string): Promise<ChannelEventRecord[]> {
    const db = await getDB();
    const index = db
      .transaction("channelEvents")
      .objectStore("channelEvents")
      .index("by-turn");
    return (await index.getAll(channelTurnId)) as ChannelEventRecord[];
  }

  async putOutbox(record: ChannelOutboxRecord): Promise<void> {
    const db = await getDB();
    await db.put("channelOutbox", record);
  }

  async getOutboxRecord(
    deliveryId: string,
  ): Promise<ChannelOutboxRecord | null> {
    const db = await getDB();
    return (await db.get("channelOutbox", deliveryId)) ?? null;
  }

  async listOutboxByTurn(channelTurnId: string): Promise<ChannelOutboxRecord[]> {
    const db = await getDB();
    const index = db
      .transaction("channelOutbox")
      .objectStore("channelOutbox")
      .index("by-turn");
    return (await index.getAll(channelTurnId)) as ChannelOutboxRecord[];
  }

  async listOutboxByDeliveryStatus(
    deliveryStatus: ChannelDeliveryStatus,
  ): Promise<ChannelOutboxRecord[]> {
    const db = await getDB();
    const index = db
      .transaction("channelOutbox")
      .objectStore("channelOutbox")
      .index("by-delivery-status");
    return (await index.getAll(deliveryStatus)) as ChannelOutboxRecord[];
  }

  async clearAll(): Promise<void> {
    const db = await getDB();
    const tx = db.transaction([...CHANNEL_STORE_NAMES], "readwrite");
    for (const storeName of CHANNEL_STORE_NAMES) {
      await tx.objectStore(storeName).clear();
    }
    await tx.done;
  }

  buildBindingKey(
    channelKind: ChannelKind,
    remoteConversationId: string,
  ): string {
    return buildChannelBindingKey(channelKind, remoteConversationId);
  }

  buildConversationKey(
    channelKind: ChannelKind,
    remoteConversationId: string,
  ): string {
    return buildChannelConversationKey(channelKind, remoteConversationId);
  }
}
