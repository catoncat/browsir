import { getBrowserWs, browserWsSend } from "./chrome";

// Global CDP message ID counter — shared across all CdpClient instances to avoid
// ID collisions when multiple clients multiplex through the same browser WebSocket.
let _globalCdpId = 1;

export class CdpClient {
  private ws: WebSocket | null = null;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void; timer: Timer }>();
  private closed = false;
  private sessionId?: string;
  private ownsWs: boolean;

  constructor(
    private readonly name: string,
    private readonly wsUrl: string
  ) {
    this.ownsWs = true;
  }

  /** Create a CdpClient that multiplexes through a shared browser-level WebSocket. */
  static fromSession(name: string, sharedWs: WebSocket, sessionId: string): CdpClient {
    const client = new CdpClient(name, "");
    client.ws = sharedWs;
    client.sessionId = sessionId;
    client.ownsWs = false;
    client.closed = false;
    sharedWs.addEventListener("message", (event: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.sessionId !== sessionId) return;
      if (typeof msg?.id !== "number") return;
      const record = client.pending.get(msg.id);
      if (!record) return;
      client.pending.delete(msg.id);
      clearTimeout(record.timer);
      if (msg.error) {
        record.reject(new Error(`${name}: ${msg.error.message || "CDP error"}`));
        return;
      }
      record.resolve(msg.result ?? null);
    });
    return client;
  }

  async connect(timeoutMs = 12_000): Promise<void> {
    if (!this.ownsWs) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    const bws = getBrowserWs();
    if (bws && bws.readyState === WebSocket.OPEN) {
      const targetIdMatch = /\/devtools\/page\/([A-F0-9]+)$/i.exec(this.wsUrl);
      if (targetIdMatch) {
        const targetId = targetIdMatch[1];
        const attachResult = await browserWsSend("Target.attachToTarget", { targetId, flatten: true });
        const sessionId = attachResult.sessionId as string;
        this.ws = bws;
        this.sessionId = sessionId;
        this.ownsWs = false;
        this.closed = false;
        bws.addEventListener("message", (event: MessageEvent) => {
          let msg: any;
          try { msg = JSON.parse(String(event.data)); } catch { return; }
          if (msg.sessionId !== sessionId) return;
          if (typeof msg?.id !== "number") return;
          const record = this.pending.get(msg.id);
          if (!record) return;
          this.pending.delete(msg.id);
          clearTimeout(record.timer);
          if (msg.error) {
            record.reject(new Error(`${this.name}: ${msg.error.message || "CDP error"}`));
            return;
          }
          record.resolve(msg.result ?? null);
        });
        return;
      }
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(`${this.name}: ${message}`));
      };

      const timer = setTimeout(() => fail(`websocket 连接超时 ${this.wsUrl}`), timeoutMs);
      const ws = new WebSocket(this.wsUrl);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        this.ws = ws;
        resolve();
      });

      ws.addEventListener("message", (event) => {
        let msg: any;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }

        if (typeof msg?.id !== "number") return;
        const record = this.pending.get(msg.id);
        if (!record) return;
        this.pending.delete(msg.id);
        clearTimeout(record.timer);

        if (msg.error) {
          record.reject(new Error(`${this.name}: ${msg.error.message || "CDP error"}`));
          return;
        }
        record.resolve(msg.result ?? null);
      });

      ws.addEventListener("close", () => {
        this.closed = true;
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`${this.name}: websocket 已关闭`));
        }
        this.pending.clear();
      });

      ws.addEventListener("error", () => {
        fail("websocket 连接失败");
      });
    });
  }

  async close(): Promise<void> {
    if (!this.ownsWs || !this.ws) return;
    this.ws.close();
    this.ws = null;
  }

  async send(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<any> {
    if (this.closed) throw new Error(`${this.name}: websocket 已关闭`);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`${this.name}: websocket 未连接`);
    }

    const id = _globalCdpId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (this.sessionId) payload.sessionId = this.sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: CDP 调用超时 ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(payload));
    });
  }

  async evaluate(
    expression: string,
    options: { awaitPromise?: boolean; returnByValue?: boolean; timeoutMs?: number } = {}
  ): Promise<any> {
    const out = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: options.awaitPromise ?? true,
        returnByValue: options.returnByValue ?? true
      },
      options.timeoutMs ?? 20_000
    );

    if (out?.exceptionDetails) {
      const description = out?.result?.description || out?.exceptionDetails?.text || "Runtime.evaluate exception";
      throw new Error(`${this.name}: ${description}`);
    }

    if (options.returnByValue === false) {
      return out?.result;
    }
    return out?.result?.value;
  }
}
