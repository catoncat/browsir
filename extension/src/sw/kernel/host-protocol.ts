export const HOST_PROTOCOL_VERSION = "bbl.host.v1";

export type HostServiceId = "wechat";

export interface HostCommandEnvelope<TPayload = Record<string, unknown>> {
  type: "host.command";
  protocolVersion: typeof HOST_PROTOCOL_VERSION;
  id: string;
  service: HostServiceId;
  action: string;
  payload: TPayload;
}

export interface HostSuccessEnvelope<TData = unknown> {
  type: "host.response";
  protocolVersion: typeof HOST_PROTOCOL_VERSION;
  id: string;
  service: HostServiceId;
  action: string;
  ok: true;
  data: TData;
}

export interface HostErrorEnvelope {
  type: "host.response";
  protocolVersion: typeof HOST_PROTOCOL_VERSION;
  id: string;
  service: HostServiceId;
  action: string;
  ok: false;
  error: string;
}

export type HostResponseEnvelope<TData = unknown> =
  | HostSuccessEnvelope<TData>
  | HostErrorEnvelope;

export type WechatLoginStatus = "logged_out" | "pending" | "logged_in" | "error";

export interface WechatHostStateSnapshot {
  hostEpoch: string;
  protocolVersion: typeof HOST_PROTOCOL_VERSION;
  login: {
    status: WechatLoginStatus;
    updatedAt: string;
    qrCode?: string;
    qrImageUrl?: string;
    baseUrl?: string;
    accountId?: string;
    botUserId?: string;
    lastError?: string;
  };
}

export interface WechatReplySendInput {
  deliveryId: string;
  channelTurnId: string;
  sessionId: string;
  userId: string;
  parts: Array<{ kind: "text"; text: string }>;
}

export interface WechatReplySendResult {
  deliveryId: string;
  sentAt: string;
}
