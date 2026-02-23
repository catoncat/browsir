export class BridgeError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

export function isBridgeError(err: unknown): err is BridgeError {
  return err instanceof BridgeError;
}

export function errorToPayload(err: unknown): { code: string; message: string; details?: unknown } {
  if (isBridgeError(err)) {
    return {
      code: err.code,
      message: err.message,
      details: err.details,
    };
  }

  if (err instanceof Error) {
    return {
      code: "E_INTERNAL",
      message: err.message,
    };
  }

  return {
    code: "E_INTERNAL",
    message: "Unknown error",
  };
}
