interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export async function sendMessage<T = unknown>(
  type: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const response = (await chrome.runtime.sendMessage({
    type,
    ...payload,
  })) as RuntimeResponse<T>;
  if (!response?.ok) {
    throw new Error(response?.error || `${type} failed`);
  }
  return response.data as T;
}
