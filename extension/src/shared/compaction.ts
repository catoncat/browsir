export interface CompactionSettings {
  enabled: boolean;
  contextWindowTokens: number;
  reserveTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  contextWindowTokens: 128_000,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

function toPositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

export function normalizeCompactionSettings(
  value: unknown,
  fallback: CompactionSettings = DEFAULT_COMPACTION_SETTINGS,
): CompactionSettings {
  const row =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    enabled: row.enabled === undefined ? fallback.enabled : row.enabled === true,
    contextWindowTokens: toPositiveInt(
      row.contextWindowTokens,
      fallback.contextWindowTokens,
    ),
    reserveTokens: toPositiveInt(row.reserveTokens, fallback.reserveTokens),
    keepRecentTokens: toPositiveInt(
      row.keepRecentTokens,
      fallback.keepRecentTokens,
    ),
  };
}
