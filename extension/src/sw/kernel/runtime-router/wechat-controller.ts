import { sendHostCommand } from "../channel-broker";
import type { WechatHostStateSnapshot } from "../host-protocol";

type RuntimeOk<T = unknown> = { ok: true; data: T };
type RuntimeErr = { ok: false; error: string };
type RuntimeResult<T = unknown> = RuntimeOk<T> | RuntimeErr;

function ok<T>(data: T): RuntimeOk<T> {
  return { ok: true, data };
}

function fail(error: string): RuntimeErr {
  return { ok: false, error };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export async function handleBrainChannelWechat(
  message: unknown,
): Promise<RuntimeResult<WechatHostStateSnapshot>> {
  const payload = toRecord(message);
  const action = String(payload.type || "");

  try {
    if (action === "brain.channel.wechat.get_state") {
      return ok(
        await sendHostCommand<Record<string, unknown>, WechatHostStateSnapshot>(
          "wechat",
          "get_state",
          {},
        ),
      );
    }

    if (action === "brain.channel.wechat.login.start") {
      return ok(
        await sendHostCommand<Record<string, unknown>, WechatHostStateSnapshot>(
          "wechat",
          "login.start",
          {},
        ),
      );
    }

    if (action === "brain.channel.wechat.logout") {
      return ok(
        await sendHostCommand<Record<string, unknown>, WechatHostStateSnapshot>(
          "wechat",
          "logout",
          {},
        ),
      );
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  return fail(`unsupported wechat action: ${action}`);
}
