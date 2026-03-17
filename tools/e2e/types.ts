import type { VisualReviewReport } from "../lib/visual-review";

export interface JsonVersion {
  webSocketDebuggerUrl: string;
}

export interface JsonTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
}

export interface RuntimeMessageResponse {
  ok?: boolean;
  data?: any;
  error?: string;
  [key: string]: any;
}

export interface TestCaseResult {
  group: string;
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  error?: string;
}

export interface MockLlmRequest {
  ts: string;
  userText: string;
  messageCount: number;
  hasToolResult: boolean;
  toolCallIds: string[];
  assistantToolCallIds: string[];
  hasPairedToolContext: boolean;
  hasSharedTabsContext: boolean;
  toolMessages: string[];
}

export interface MockLlmServer {
  baseUrl: string;
  getRequests: () => MockLlmRequest[];
  clearRequests: () => void;
  stop: () => Promise<void>;
}

export type RunCaseFn = (
  group: string,
  name: string,
  fn: () => Promise<void>
) => Promise<void>;

export type SendBgMessageFn = (
  client: CdpClientLike,
  msg: Record<string, unknown>,
  timeoutMs?: number
) => Promise<RuntimeMessageResponse>;

export interface CdpClientLike {
  evaluate(
    expression: string,
    options?: { awaitPromise?: boolean; returnByValue?: boolean; timeoutMs?: number }
  ): Promise<any>;
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  connect(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Shared context passed to all test case registration functions.
 */
export interface E2eContext {
  sidepanelClient: CdpClientLike;
  debugClient: CdpClientLike;
  pageClient: CdpClientLike;
  mockLlm: MockLlmServer | null;
  testTabId: number;
  chromePort: number;
  bridgePort: number;
  bridgeToken: string;
  extId: string;
  useExternalChrome: boolean;
  useLiveLlmSuite: boolean;
  headless: boolean;
  liveLlmBase: string;
  liveLlmKey: string;
  liveLlmModel: string;

  runCase: RunCaseFn;
  sendBgMessage: SendBgMessageFn;
  acquireAndUseLease: (owner: string, fn: (owner: string) => Promise<void>, ttlMs?: number) => Promise<void>;
  resetTestPageFixture: () => Promise<void>;
  createTarget: (port: number, url: string) => Promise<JsonTarget>;
  closeTarget: (port: number, targetId: string) => Promise<void>;
  activateTarget: (port: number, targetId: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  assert: (condition: unknown, message: string) => asserts condition;
  waitFor: <T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs?: number, intervalMs?: number) => Promise<T>;
}
