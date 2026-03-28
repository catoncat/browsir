export const HOST_PROTOCOL_VERSION = "bbl.host.v1";
export const WECHAT_HOST_STATE_EVENT_TYPE = "brain.channel.wechat.host_state";

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

export type WechatAuthStatus =
  | "logged_out"
  | "pending_qr"
  | "authenticated"
  | "reauth_required";

export type WechatTransportStatus =
  | "stopped"
  | "starting"
  | "healthy"
  | "backing_off"
  | "degraded";

export interface WechatHostStateSnapshot {
  hostEpoch: string;
  protocolVersion: typeof HOST_PROTOCOL_VERSION;
  enabled: boolean;
  auth: {
    status: WechatAuthStatus;
    updatedAt: string;
    qrCode?: string;
    qrImageUrl?: string;
    baseUrl?: string;
    accountId?: string;
    botUserId?: string;
    lastError?: string;
  };
  transport: {
    status: WechatTransportStatus;
    updatedAt: string;
    resumable: boolean;
    consecutiveFailures: number;
    nextRetryAt?: string;
    lastSuccessAt?: string;
    lastError?: string;
  };
  resume: {
    resumable: boolean;
    lastResumeAt?: string;
    lastResumeReason?: string;
  };
}

export interface WechatReplySendInput {
  deliveryId: string;
  channelTurnId: string;
  sessionId: string;
  userId: string;
  parts: Array<{ kind: "text"; text: string; clientId?: string }>;
}

export interface WechatReplySendResult {
  deliveryId: string;
  sentAt: string;
  deliveredPartCount: number;
  complete: boolean;
  lastError?: string;
}
