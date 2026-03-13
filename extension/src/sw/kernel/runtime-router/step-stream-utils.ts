const DEFAULT_STEP_STREAM_MAX_EVENTS = 240;
const DEFAULT_STEP_STREAM_MAX_BYTES = 256 * 1024;
const MAX_STEP_STREAM_MAX_EVENTS = 5000;
const MAX_STEP_STREAM_MAX_BYTES = 4 * 1024 * 1024;

function normalizeIntInRange(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

function estimateJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

export function clampStepStream(
  source: unknown[],
  rawOptions: { maxEvents?: unknown; maxBytes?: unknown } = {},
): {
  stream: unknown[];
  meta: {
    truncated: boolean;
    cutBy: "events" | "bytes" | null;
    totalEvents: number;
    totalBytes: number;
    returnedEvents: number;
    returnedBytes: number;
    maxEvents: number;
    maxBytes: number;
  };
} {
  const stream = Array.isArray(source) ? source : [];
  const maxEvents = normalizeIntInRange(
    rawOptions.maxEvents,
    DEFAULT_STEP_STREAM_MAX_EVENTS,
    1,
    MAX_STEP_STREAM_MAX_EVENTS,
  );
  const maxBytes = normalizeIntInRange(
    rawOptions.maxBytes,
    DEFAULT_STEP_STREAM_MAX_BYTES,
    2 * 1024,
    MAX_STEP_STREAM_MAX_BYTES,
  );
  const totalEvents = stream.length;
  const totalBytes = stream.reduce<number>(
    (sum, item) => sum + estimateJsonBytes(item),
    0,
  );

  if (totalEvents <= maxEvents && totalBytes <= maxBytes) {
    return {
      stream: stream.slice(),
      meta: {
        truncated: false,
        cutBy: null,
        totalEvents,
        totalBytes,
        returnedEvents: totalEvents,
        returnedBytes: totalBytes,
        maxEvents,
        maxBytes,
      },
    };
  }

  const picked: unknown[] = [];
  let returnedBytes = 0;
  let cutBy: "events" | "bytes" | null = null;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const item = stream[i];
    const bytes = estimateJsonBytes(item);
    const exceedEvents = picked.length + 1 > maxEvents;
    const exceedBytes = returnedBytes + bytes > maxBytes;
    if (exceedEvents || exceedBytes) {
      cutBy = exceedEvents ? "events" : "bytes";
      if (picked.length === 0) {
        picked.push(item);
        returnedBytes += bytes;
      }
      break;
    }
    picked.push(item);
    returnedBytes += bytes;
  }
  picked.reverse();
  return {
    stream: picked,
    meta: {
      truncated: true,
      cutBy,
      totalEvents,
      totalBytes,
      returnedEvents: picked.length,
      returnedBytes,
      maxEvents,
      maxBytes,
    },
  };
}
