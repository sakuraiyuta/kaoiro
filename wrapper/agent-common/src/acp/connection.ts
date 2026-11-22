import { Readable, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";

/** ACP-only wire metadata; an engine adds fields through AcpExtension. */
export interface WireMetadata {
  direction: "in" | "out";
  method?: string;
  variant?: string;
  sdk_diagnostic?: boolean;
  oversized_lines?: number;
}
type Observer = (metadata: WireMetadata) => void;
type VendorFields<M extends WireMetadata> = Partial<
  Omit<M, keyof WireMetadata>
>;

/**
 * An extra notification beyond the ACP client methods. ACP names extension
 * methods with a leading underscore; connectAcp rejects any other name.
 */
export interface AcpNotification<P = unknown> {
  method: string;
  parse: (params: unknown) => P;
  handle: (params: P) => void;
}

export function notification<P>(
  method: string,
  parse: (params: unknown) => P,
  handle: (params: P) => void,
): AcpNotification {
  return { method, parse, handle } as AcpNotification;
}

export interface AcpWriteResult {
  method?: string;
  id?: string | number | null;
  ok: boolean;
}

/**
 * Everything an engine injects into the ACP client. The default (no
 * extension) registers ACP methods only and adds no vendor metadata.
 */
export interface AcpExtension<M extends WireMetadata = WireMetadata> {
  /**
   * Reports each write attempted on child stdin. A failed write closes
   * the connection. Messages still queued by the SDK receive no report.
   */
  onWrite?: (result: AcpWriteResult) => void;
  notifications?: readonly AcpNotification[];
  /**
   * Vendor fields for one parsed JSON-RPC line, merged after `variant`. A
   * throw drops that line's metadata and never interrupts the transport.
   */
  wireFields?: (message: Record<string, unknown>) => VendorFields<M>;
}

const observers = new Set<Observer>();
let restoreConsole: (() => void) | undefined;

export function safeName(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w./-]{1,120}$/.test(value)
    ? value
    : undefined;
}

function filterSdkConsole(observer: Observer): () => void {
  observers.add(observer);
  if (!restoreConsole) {
    const error = console.error;
    const warn = console.warn;
    console.error = (...args: unknown[]) => {
      const prefix = args[0];
      if (
        typeof prefix === "string" &&
        (prefix === "Invalid message" ||
          prefix === "Error handling notification" ||
          prefix === "Got response to unknown request" ||
          /^ACP connection .* router stopped unexpectedly:/.test(prefix))
      ) {
        for (const onMetadata of observers) {
          onMetadata({ direction: "in", sdk_diagnostic: true });
        }
        return;
      }
      error(...args);
    };
    console.warn = (...args: unknown[]) => {
      if (
        typeof args[0] === "string" &&
        /^Closing ACP connection /.test(args[0])
      ) {
        for (const onMetadata of observers) {
          onMetadata({ direction: "in", sdk_diagnostic: true });
        }
      } else warn(...args);
    };
    restoreConsole = () => {
      console.error = error;
      console.warn = warn;
    };
  }
  return () => {
    observers.delete(observer);
    if (observers.size === 0) {
      restoreConsole?.();
      restoreConsole = undefined;
    }
  };
}

const metadataLimit = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function observeMessage<M extends WireMetadata>(
  msg: Record<string, unknown>,
  direction: "in" | "out",
  observer: (metadata: M) => void,
  wireFields?: AcpExtension<M>["wireFields"],
) {
  const method = safeName(msg.method);
  const update = isRecord(msg.params) ? msg.params.update : undefined;
  const variant = isRecord(update) ? safeName(update.sessionUpdate) : undefined;
  observer({
    direction,
    ...(method ? { method } : {}),
    ...(variant ? { variant } : {}),
    ...(wireFields?.(msg) ?? {}),
  } as M);
}

export function metadataTee<M extends WireMetadata = WireMetadata>(
  direction: "in" | "out",
  observer: (metadata: M) => void,
  wireFields?: AcpExtension<M>["wireFields"],
) {
  let buffer = "";
  let bytes = 0;
  let oversized = false;
  const decoder = new TextDecoder();
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      let offset = 0;
      while (offset < text.length) {
        const newline = text.indexOf("\n", offset);
        const end = newline < 0 ? text.length : newline;
        if (!oversized) {
          const part = text.slice(offset, end);
          bytes += Buffer.byteLength(part);
          if (bytes > metadataLimit) {
            buffer = "";
            oversized = true;
            try {
              observer({ direction, oversized_lines: 1 } as M);
            } catch {
              /* Diagnostics must not interrupt the protocol transport. */
            }
          } else buffer += part;
        }
        if (newline < 0) break;
        const line = oversized ? "" : buffer;
        buffer = "";
        bytes = 0;
        oversized = false;
        offset = newline + 1;
        try {
          const msg: unknown = JSON.parse(line);
          if (!isRecord(msg)) continue;
          observeMessage(msg, direction, observer, wireFields);
        } catch {
          /* Invalid JSON is handled by the SDK, without body logging. */
        }
      }
      controller.enqueue(chunk);
    },
  });
}

function callbackOutput<M extends WireMetadata>(
  child: ChildProcessWithoutNullStreams,
  metadata: (metadata: M) => void,
  wireFields: AcpExtension<M>["wireFields"],
  onWrite: (result: AcpWriteResult) => void,
  closeConnection: (error: Error) => void,
) {
  const { stdin } = child;
  let pending: ((error?: Error | null) => void) | undefined;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    pending?.(error);
    closeConnection(error);
  };
  const closed = () => fail(new Error("ACP output closed"));
  const cleanup = () => {
    closed();
    stdin.off("error", fail);
    child.off("close", closed);
  };
  stdin.on("error", fail);
  stdin.once("close", cleanup);
  child.once("close", closed);

  return new WritableStream<Uint8Array>({
    write(chunk) {
      if (failure) throw failure;
      // The pinned SDK encodes one complete JSON-RPC message per write.
      const msg: Record<string, unknown> & Pick<AcpWriteResult, "id"> =
        JSON.parse(new TextDecoder().decode(chunk));
      const method = safeName(msg.method);
      const identity = {
        ...(method !== undefined ? { method } : {}),
        ...(msg.id !== undefined ? { id: msg.id } : {}),
      };
      try {
        if (chunk.byteLength - 1 > metadataLimit) {
          metadata({ direction: "out", oversized_lines: 1 } as M);
        } else {
          observeMessage(msg, "out", metadata, wireFields);
        }
      } catch {
        // Diagnostic observers cannot block transport.
      }
      return new Promise<void>((resolve, reject) => {
        const finish = (error?: Error | null) => {
          if (pending !== finish) return;
          pending = undefined;
          try {
            onWrite({ ...identity, ok: !error });
          } catch {
            // A notification cannot change the native write outcome.
          }
          if (error) {
            reject(error);
            fail(error);
          } else resolve();
        };
        pending = finish;
        try {
          stdin.write(chunk, finish);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("ACP write failed"));
        }
      });
    },
    close() { stdin.end(); },
    abort() { stdin.destroy(); },
  });
}

export interface AcpHandlers<M extends WireMetadata = WireMetadata> {
  update: (notification: acp.SessionNotification) => void;
  permission: (
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<acp.RequestPermissionResponse>;
  metadata: (metadata: M) => void;
}

export function connectAcp<M extends WireMetadata = WireMetadata>(
  child: ChildProcessWithoutNullStreams,
  handlers: AcpHandlers<M>,
  extension: AcpExtension<M> = {},
) {
  for (const { method } of extension.notifications ?? []) {
    if (!method.startsWith("_")) {
      throw new Error(
        `ACP extension notification "${method}" must start with "_"`,
      );
    }
  }
  const observer = handlers.metadata as Observer;
  const release = filterSdkConsole(observer);
  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  let output: WritableStream<Uint8Array>;
  if (extension.onWrite) {
    output = callbackOutput(child, handlers.metadata, extension.wireFields,
      extension.onWrite, (error) => connection.close(error));
  } else {
    const tee = metadataTee("out", handlers.metadata, extension.wireFields);
    void tee.readable.pipeTo(Writable.toWeb(child.stdin)).catch(() => {});
    output = tee.writable;
  }
  const stream = acp.ndJsonStream(
    output,
    input.pipeThrough(
      metadataTee("in", handlers.metadata, extension.wireFields),
    ),
  );
  const app = acp
    .client({ name: "kaoiro" })
    .onNotification(acp.methods.client.session.update, (ctx) =>
      handlers.update(ctx.params),
    );
  for (const extra of extension.notifications ?? []) {
    app.onNotification(extra.method, extra.parse, (ctx) =>
      extra.handle(ctx.params),
    );
  }
  const connection = app
    .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
      handlers.permission(ctx.params, ctx.signal),
    )
    .connect(stream);
  void connection.closed.finally(release).catch(() => {});
  return connection;
}
