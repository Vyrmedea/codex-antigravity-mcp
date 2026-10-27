import { ChildProcess, spawn } from "node:child_process";

export interface JsonRpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcHandlers {
  onNotification?: (notification: JsonRpcNotification) => void;
  onServerRequest?: (request: JsonRpcRequest) => void;
  onDisconnect?: (error: Error) => void;
  onStderr?: (chunk: string) => void;
}

export class JsonRpcConnection {
  private static nextRequestId = 1;

  private child: ChildProcess | null = null;
  private pendingRequests = new Map<
    number | string,
    {
      resolve: (result: any) => void;
      reject: (error: Error) => void;
      method: string;
    }
  >();
  private lineBuffer = "";
  private isClosed = false;
  private disconnectReason: Error | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly handlers: JsonRpcHandlers = {}
  ) {}

  public start(): void {
    if (this.child) {
      return;
    }

    this.isClosed = false;
    this.disconnectReason = null;
    this.lineBuffer = "";

    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
      },
    });

    const activeChild = this.child;

    activeChild.stdout?.on("data", (chunk: Buffer) => {
      if (this.child !== activeChild || this.isClosed) return;
      this.handleStdoutData(chunk.toString("utf8"));
    });

    activeChild.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.handlers.onStderr?.(text);
    });

    activeChild.on("error", (err: Error) => {
      if (this.child !== activeChild) return;
      this.handleClose(new Error(`Child process error: ${err.message}`));
    });

    activeChild.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child !== activeChild) return;
      const msg = `Child process exited with code ${code ?? "null"} signal ${signal ?? "null"}`;
      this.handleClose(new Error(msg));
    });

    activeChild.stdout?.on("end", () => {
      if (this.child !== activeChild) return;
      this.handleClose(new Error("Child process stdout reached EOF"));
    });

    activeChild.stdout?.on("close", () => {
      if (this.child !== activeChild) return;
      this.handleClose(new Error("Child process stdout closed"));
    });
  }

  public async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.isClosed || !this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error(
        `Cannot send request "${method}": connection is closed (${this.disconnectReason?.message || "disconnected"})`
      );
    }

    const id = JsonRpcConnection.nextRequestId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, method });
      try {
        this.child!.stdin!.write(payload + "\n", "utf8", (err) => {
          if (err) {
            this.pendingRequests.delete(id);
            reject(new Error(`Failed to write request "${method}": ${err.message}`));
          }
        });
      } catch (err: any) {
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  public notify(method: string, params?: unknown): void {
    if (this.isClosed || !this.child || !this.child.stdin || this.child.stdin.destroyed) {
      return;
    }
    const payload = JSON.stringify({ method, params });
    try {
      this.child.stdin.write(payload + "\n", "utf8");
    } catch {
      // Ignore write errors on disconnected socket
    }
  }

  public respond(id: number | string, result?: unknown, error?: unknown): void {
    if (this.isClosed || !this.child || !this.child.stdin || this.child.stdin.destroyed) {
      return;
    }
    const responsePayload: Record<string, unknown> = { id };
    if (error !== undefined) {
      responsePayload.error = error;
    } else {
      responsePayload.result = result ?? null;
    }
    try {
      this.child.stdin.write(JSON.stringify(responsePayload) + "\n", "utf8");
    } catch {
      // Ignore write errors on disconnected socket
    }
  }

  public close(): void {
    this.handleClose(new Error("Connection manually closed"));
    if (this.child && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        // Ignore kill errors
      }
    }
  }

  public get closed(): boolean {
    return this.isClosed;
  }

  private handleStdoutData(data: string): void {
    this.lineBuffer += data;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.parseMessage(line);
      }
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  private parseMessage(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch (e: any) {
      this.handlers.onStderr?.(`[JsonRpcConnection] Failed to parse JSON line: ${line}\n`);
      return;
    }

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      // RPC Response to our request
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          const errMsg =
            typeof msg.error === "string"
              ? msg.error
              : msg.error.message || JSON.stringify(msg.error);
          pending.reject(new Error(`RPC error on "${pending.method}": ${errMsg}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.id !== undefined && typeof msg.method === "string") {
      // Reverse RPC Request from Server
      this.handlers.onServerRequest?.({
        id: msg.id,
        method: msg.method,
        params: msg.params,
      });
      return;
    }

    if (typeof msg.method === "string") {
      // Notification
      this.handlers.onNotification?.({
        method: msg.method,
        params: msg.params,
      });
      return;
    }
  }

  private handleClose(reason: Error): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.disconnectReason = reason;

    // Reject all in-flight requests
    const pendingList = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();
    for (const pending of pendingList) {
      pending.reject(
        new Error(`RPC request "${pending.method}" aborted: ${reason.message}`)
      );
    }

    this.handlers.onDisconnect?.(reason);
  }
}
