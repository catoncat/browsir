const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "1.0.0";

export interface WechatQrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface WechatQrStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
}

export interface WechatCredentials {
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
}

export interface WechatMessage {
  message_id: number;
  from_user_id: string;
  to_user_id: string;
  client_id: string;
  create_time_ms: number;
  message_type: 1 | 2;
  message_state: 0 | 1 | 2;
  context_token: string;
  item_list: Array<{
    type: number;
    text_item?: { text: string };
  }>;
}

export interface WechatGetUpdatesResponse {
  ret: number;
  msgs: WechatMessage[];
  get_updates_buf: string;
  longpolling_timeout_ms?: number;
  errcode?: number;
  errmsg?: string;
}

export class WechatApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly payload?: unknown;

  constructor(
    message: string,
    options: { status: number; code?: number; payload?: unknown },
  ) {
    super(message);
    this.name = "WechatApiError";
    this.status = options.status;
    this.code = options.code;
    this.payload = options.payload;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function randomWechatUin(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return btoa(String(bytes[0]));
}

function buildHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": randomWechatUin(),
  };
}

function buildBaseInfo(): { channel_version: string } {
  return { channel_version: CHANNEL_VERSION };
}

async function parseJsonResponse<T>(
  response: Response,
  label: string,
): Promise<T> {
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as T) : ({} as T);
  if (!response.ok) {
    const row = payload as { errmsg?: string; errcode?: number } | null;
    throw new WechatApiError(
      row?.errmsg || `${label} failed with HTTP ${response.status}`,
      {
        status: response.status,
        code: row?.errcode,
        payload,
      },
    );
  }
  if (
    typeof (payload as { ret?: number } | null)?.ret === "number" &&
    (payload as { ret: number }).ret !== 0
  ) {
    const row = payload as { errmsg?: string; errcode?: number; ret: number };
    throw new WechatApiError(row.errmsg || `${label} failed`, {
      status: response.status,
      code: row.errcode ?? row.ret,
      payload,
    });
  }
  return payload;
}

async function apiGet<T>(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const url = new URL(path, `${normalizeBaseUrl(baseUrl)}/`);
  const response = await fetch(url, {
    method: "GET",
    headers,
  });
  return parseJsonResponse<T>(response, path);
}

async function apiPost<T>(
  baseUrl: string,
  endpoint: string,
  body: unknown,
  token: string,
  timeoutMs = 40_000,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(endpoint, `${normalizeBaseUrl(baseUrl)}/`);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
    signal: requestSignal,
  });
  return parseJsonResponse<T>(response, endpoint);
}

export async function fetchQrCode(
  baseUrl = DEFAULT_BASE_URL,
): Promise<WechatQrCodeResponse> {
  return apiGet<WechatQrCodeResponse>(
    baseUrl,
    "/ilink/bot/get_bot_qrcode?bot_type=3",
  );
}

export async function pollQrStatus(
  baseUrl: string,
  qrcode: string,
): Promise<WechatQrStatusResponse> {
  return apiGet<WechatQrStatusResponse>(
    baseUrl,
    `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    {
      "iLink-App-ClientVersion": "1",
    },
  );
}

export async function getUpdates(
  baseUrl: string,
  token: string,
  cursor: string,
  signal?: AbortSignal,
): Promise<WechatGetUpdatesResponse> {
  return apiPost<WechatGetUpdatesResponse>(
    baseUrl,
    "/ilink/bot/getupdates",
    {
      get_updates_buf: cursor,
      base_info: buildBaseInfo(),
    },
    token,
    40_000,
    signal,
  );
}

export async function sendTextMessage(input: {
  baseUrl: string;
  token: string;
  userId: string;
  contextToken: string;
  text: string;
}): Promise<Record<string, unknown>> {
  return apiPost<Record<string, unknown>>(
    input.baseUrl,
    "/ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: input.userId,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        context_token: input.contextToken,
        item_list: [
          {
            type: 1,
            text_item: { text: input.text },
          },
        ],
      },
      base_info: buildBaseInfo(),
    },
    input.token,
    15_000,
  );
}

export { DEFAULT_BASE_URL };
