import type { Readable } from "node:stream";

/** A JSON-RPC 2.0 message as ACP agents actually send them. */
export interface AcpWireMessage {
  jsonrpc?: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Complete lines in a stream buffer, plus the unterminated tail to keep. */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((line) => line.replace(/\r$/u, "")), rest };
}

export interface AcpConnectionOptions {
  /** Write one serialized frame (the agent's stdin). A throw is the caller's
   *  policy: the turn runtime swallows write errors after the child is gone,
   *  probe clients let them reject the request that caused them. */
  write(line: string): void;
  /** The agent's stdout; the connection frames complete lines off it. */
  stdout: Readable;
  /** Observe every raw chunk before framing (startup byte counters). */
  onData?(chunk: string): void;
  /** First look at a complete line (sign-in link announcements). Return true
   *  to keep the line out of protocol parsing. */
  onLine?(line: string): boolean | undefined;
  /** Observe every outgoing message after its frame is written (native log). */
  onSend?(message: AcpWireMessage): void;
  /** Observe every parsed incoming message before dispatch (native log). */
  onMessage?(message: AcpWireMessage): void;
  /** A server→client request (id + method, no result yet). */
  onServerRequest?(message: AcpWireMessage): void;
  /** A server→client notification (method, no id). */
  onNotification?(message: AcpWireMessage): void;
  /** Called once when close() marks the connection closed — the kill policy
   *  stays with the driver that owns the process. */
  onClose?(): void;
  /** Fail every pending request when the buffer grows past this many bytes. */
  maxLineBytes?: number;
  /** Rejection message when a frame outgrows maxLineBytes. */
  oversizedLineMessage?: string;
  /** Rejection for requests made after close(). */
  closedErrorMessage?: string;
  /** Rejection handed to pending requests by close(). */
  closeErrorMessage?: string;
  /** Rejection message when an error response carries no message. */
  errorFallbackMessage?: string;
  /** Rejection message when a request times out. */
  timeoutMessage?(method: string, timeoutMs: number): string;
}

/** One client→agent request awaiting its response. */
interface PendingRpc {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** One JSON-RPC-2.0-over-stdio connection to an ACP agent. The connection
 *  owns framing, request/response correlation, timeouts, and dispatch of
 *  notifications and server→client requests; the caller owns the process and
 *  every policy (logging, permission answers, shutdown). */
export class AcpConnection {
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private buffer = "";
  private closed = false;
  private readonly options: AcpConnectionOptions;

  constructor(options: AcpConnectionOptions) {
    this.options = options;
    // decode as UTF-8 across chunk boundaries — a raw `buffer += chunk` splits
    // multibyte characters that straddle two reads and corrupts the text
    options.stdout.setEncoding("utf8");
    options.stdout.on("data", (chunk: string) => this.consume(chunk));
  }

  /** Whether close() has run — later requests reject. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Serialize and write one message — a request, a notification, or a
   *  response to a server request. */
  send(message: AcpWireMessage): void {
    this.options.write(`${JSON.stringify(message)}\n`);
    this.options.onSend?.(message);
  }

  /** Send a request and await its response. No `timeoutMs` means no timer —
   *  the request waits until the connection ends. `onResult` fires from the
   *  read loop before the awaiting continuation resumes, so an update that
   *  follows the response is still consumed in wire order. */
  request(method: string, params: unknown, timeoutMs?: number, onResult?: (result: any) => void): Promise<any> {
    if (this.closed) return Promise.reject(new Error(this.options.closedErrorMessage ?? "The ACP connection is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(this.options.timeoutMessage?.(method, timeoutMs) ?? `${method} timed out`));
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, {
        resolve: (result) => {
          onResult?.(result);
          resolve(result);
        },
        reject,
        timer,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Reject every pending request — a settled turn, an exited process, or
   *  close(). Timers are cleared so a late timeout cannot follow. */
  failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /** Mark the connection closed, reject pending requests, and hand the
   *  process to onClose. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error(this.options.closeErrorMessage ?? "The ACP connection was closed."));
    this.options.onClose?.();
  }

  private consume(chunk: string) {
    this.options.onData?.(chunk);
    this.buffer += chunk;
    if (this.options.maxLineBytes !== undefined && Buffer.byteLength(this.buffer) > this.options.maxLineBytes) {
      this.failAll(new Error(this.options.oversizedLineMessage ?? "The ACP connection received a protocol line that is too large."));
      this.close();
      return;
    }
    const { lines, rest } = takeLines(this.buffer);
    this.buffer = rest;
    for (const line of lines) {
      if (this.options.onLine?.(line)) continue;
      let message: AcpWireMessage;
      try {
        message = JSON.parse(line) as AcpWireMessage;
      } catch {
        continue;
      }
      this.options.onMessage?.(message);
      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (message.error) {
          const error = new Error(message.error.message ?? this.options.errorFallbackMessage ?? JSON.stringify(message.error));
          Object.assign(error, { code: message.error.code, data: message.error.data });
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
      } else if (message.id !== undefined && message.method) {
        this.options.onServerRequest?.(message);
      } else if (message.method) {
        this.options.onNotification?.(message);
      }
    }
  }
}
