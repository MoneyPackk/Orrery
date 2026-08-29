import { connect as openSocket, type Socket } from "node:net";
import {
  MAX_LINE_BYTES,
  decodeMessage,
  encodeMessage,
  type ClientRequest,
} from "@orrery/mission-control-protocol";

export interface TransportEndpoint {
  readonly host: string;
  readonly port: number;
  readonly version: string;
}

export interface LineTransport {
  connect(endpoint: TransportEndpoint): Promise<void>;
  send(message: ClientRequest): Promise<void>;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
  disconnect(): Promise<void>;
}

export class TcpLineTransport implements LineTransport {
  private socket: Socket | null = null;
  private buffer = "";
  private terminalError: Error | undefined;
  private closeNotified = false;
  private messageListener: ((message: unknown) => void) | undefined;
  private closeListener: ((error?: Error) => void) | undefined;

  async connect(endpoint: TransportEndpoint): Promise<void> {
    if (this.socket) throw new Error("Transport is already connected.");
    this.buffer = "";
    this.terminalError = undefined;
    this.closeNotified = false;
    const socket = openSocket({ host: endpoint.host, port: endpoint.port });
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(socket, chunk));
    socket.on("error", (error) => { this.terminalError ??= error; });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      const incompleteLine = this.buffer.length > 0;
      this.buffer = "";
      this.notifyClose(this.terminalError ?? (incompleteLine ? new Error("Malformed or incomplete incoming line.") : undefined));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onConnect = () => { socket.off("error", onInitialError); resolve(); };
        const onInitialError = (error: Error) => { socket.off("connect", onConnect); reject(error); };
        socket.once("connect", onConnect);
        socket.once("error", onInitialError);
      });
    } catch (error) {
      if (this.socket === socket) this.socket = null;
      socket.destroy();
      throw error;
    }
  }

  async send(message: ClientRequest): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) throw new Error("Transport is not connected.");
    await new Promise<void>((resolve, reject) => socket.write(encodeMessage(message), (error) => error ? reject(error) : resolve()));
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListener = listener;
    return () => { if (this.messageListener === listener) this.messageListener = undefined; };
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListener = listener;
    return () => { if (this.closeListener === listener) this.closeListener = undefined; };
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (!socket) { this.buffer = ""; return; }
    this.socket = null;
    this.buffer = "";
    await new Promise<void>((resolve) => {
      socket.once("close", resolve);
      socket.destroy();
    });
  }

  private receive(socket: Socket, chunk: string): void {
    if (this.socket !== socket) return;
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline + 1);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        const message = decodeMessage(line);
        this.messageListener?.(message);
      } catch (error) {
        const reason = asError(error);
        this.notifyClose(reason);
        socket.destroy();
        return;
      }
      newline = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_LINE_BYTES) {
      const reason = new Error("Incoming line is too large.");
      this.notifyClose(reason);
      socket.destroy();
    }
  }

  private notifyClose(error?: Error): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.closeListener?.(error);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
