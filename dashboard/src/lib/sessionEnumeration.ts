import type { RunnerSessions } from "./protocol";

/** The runner broadcasts one untagged list separately from the channel ack. */
interface PendingList {
  cwd: string | undefined;
  receive: (list: RunnerSessions) => void;
  cancel: () => void;
}

export class SessionEnumeration {
  private pending = new Map<string, PendingList>();

  async read(host: string, engine: string, cwd: string | undefined,
    send: () => Promise<void>, retryMessage: string): Promise<RunnerSessions> {
    const key = JSON.stringify([host, engine]);
    if (this.pending.has(key)) throw new Error(retryMessage);
    let entry!: PendingList;
    const result = new Promise<RunnerSessions>((resolve, reject) => {
      entry = { cwd, receive: resolve, cancel: () => reject(new Error(retryMessage)) };
      this.pending.set(key, entry);
    });
    try {
      const [, list] = await Promise.all([send(), result]);
      this.drop(key, entry);
      return list;
    } catch (error) {
      if (error instanceof Error && error.message === "timeout" &&
          this.pending.get(key) === entry) {
        // A timeout can still be followed by a list on this connection.
        void result.then(() => this.drop(key, entry), () => {});
        throw new Error(retryMessage);
      }
      this.drop(key, entry);
      throw error;
    }
  }

  receive(list: RunnerSessions): void {
    const entry = this.pending.get(JSON.stringify([list.host_id, list.engine]));
    if (entry && (entry.cwd === undefined || entry.cwd === list.cwd)) {
      entry.receive(list);
    }
  }

  reset(): void {
    for (const entry of this.pending.values()) entry.cancel();
    this.pending.clear();
  }

  private drop(key: string, entry: PendingList): void {
    if (this.pending.get(key) === entry) this.pending.delete(key);
  }
}
