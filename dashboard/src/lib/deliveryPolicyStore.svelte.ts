import type { Envelope, KaoiroConnection } from "./protocol";
import { DeliveryPolicyError, parseDeliveryPolicy, unknownDeliveryPolicy, hasDeliveryMechanism,
  type DeliveryPolicy, type DeliveryPolicyView } from "./deliveryPolicy";

export class DeliveryPolicyStore {
  views = $state<Record<string, DeliveryPolicyView>>({});
  notices = $state<Record<string, string>>({});
  saving = $state<Record<string, boolean>>({});
  reading = $state<Record<string, boolean>>({});
  available = $state(false);
  generation = $state(0);
  private ready = false;
  private buffered = new Map<string, DeliveryPolicyView>();
  private versions = new Map<string, number>();
  private floors = new Map<string, number>();
  private noticeEpochs = new Map<string, number>();
  private requests = new Map<string, symbol>();

  constructor(private access: () => { connection: KaoiroConnection | null; operator: boolean; connected: boolean }) {}

  reset(): void {
    this.generation++;
    this.available = false;
    this.ready = false;
    this.views = {}; this.notices = {}; this.saving = {}; this.reading = {};
    this.buffered.clear(); this.versions.clear(); this.floors.clear(); this.requests.clear(); this.noticeEpochs.clear();
  }
  disconnect(): void {
    this.generation++;
    this.available = false;
    this.saving = {}; this.reading = {};
    this.requests.clear();
  }
  snapshot(agents: Record<string, Envelope>): void {
    this.views = Object.fromEntries(Object.entries(agents).map(([id, envelope]) =>
      [id, this.buffered.get(id) ?? parseDeliveryPolicy(envelope.ext?.delivery_policy)]));
    this.buffered.clear();
    this.ready = true;
  }
  seed(envelope: Envelope): void {
    if (!Object.hasOwn(this.views, envelope.agent_id)) {
      this.views = { ...this.views, [envelope.agent_id]: parseDeliveryPolicy(envelope.ext?.delivery_policy) };
    }
  }
  event(id: string, view: DeliveryPolicyView): void {
    if (!this.ready) {
      if (this.buffered.has(id) || this.buffered.size < 200) this.buffered.set(id, view);
      return;
    }
    if (!Object.hasOwn(this.views, id)) return;
    this.observe(id, view);
  }
  private observe(id: string, view: DeliveryPolicyView): void {
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    const floor = this.floors.get(id);
    if (floor !== undefined && view.revision !== undefined && view.revision < floor) return;
    this.views = { ...this.views, [id]: view };
    if (view.revision !== undefined && floor !== undefined && view.revision >= floor) this.floors.delete(id);
    this.notices = { ...this.notices, [id]: "" };
  }
  remove(id: string): void {
    const { [id]: _view, ...views } = this.views; this.views = views;
    const { [id]: _notice, ...notices } = this.notices; this.notices = notices;
    this.buffered.delete(id); this.versions.delete(id); this.floors.delete(id); this.requests.delete(id);
  }
  clearNotice(id: string): void {
    this.noticeEpochs.set(id, (this.noticeEpochs.get(id) ?? 0) + 1);
    this.notices = { ...this.notices, [id]: "" };
  }
  private authorized(): KaoiroConnection | null {
    const access = this.access();
    return this.available && access.operator && access.connected ? access.connection : null;
  }
  async refresh(id: string, reportFailure = true): Promise<void> {
    const connection = this.authorized();
    if (!connection || !Object.hasOwn(this.views, id) || this.reading[id]) return;
    const generation = this.generation;
    const noticeEpoch = this.noticeEpochs.get(id) ?? 0;
    const version = this.versions.get(id) ?? 0;
    this.reading = { ...this.reading, [id]: true };
    try {
      const view = await connection.getDeliveryPolicy(id);
      if (generation !== this.generation || !this.authorized() || !Object.hasOwn(this.views, id) ||
          version !== (this.versions.get(id) ?? 0)) return;
      this.observe(id, view);
    } catch {
      if (reportFailure && generation === this.generation && noticeEpoch === (this.noticeEpochs.get(id) ?? 0)) this.notices = { ...this.notices, [id]: this.notices[id] === "保存結果未確認" ? "保存結果未確認・状態を再取得できませんでした" : "状態を再取得できませんでした" };
    } finally {
      if (generation === this.generation) this.reading = { ...this.reading, [id]: false };
    }
  }
  async set(id: string, policy: DeliveryPolicy, ownerConnected: boolean): Promise<void> {
    const connection = this.authorized();
    const view = this.views[id] ?? unknownDeliveryPolicy();
    if (!connection || !ownerConnected || this.saving[id] || !view.revision || !view.wrapper_support ||
        !hasDeliveryMechanism(view.mechanisms) || view.policy === policy) return;
    const generation = this.generation;
    const noticeEpoch = this.noticeEpochs.get(id) ?? 0;
    const token = Symbol(); this.requests.set(id, token);
    const version = this.versions.get(id) ?? 0;
    this.saving = { ...this.saving, [id]: true };
    this.notices = { ...this.notices, [id]: "" };
    const current = () => generation === this.generation && this.requests.get(id) === token &&
      Object.hasOwn(this.views, id) && this.authorized() !== null;
    try {
      const accepted = await connection.setDeliveryPolicy(id, policy, view.revision);
      if (!current()) return;
      const observed = this.views[id];
      if ((this.versions.get(id) ?? 0) !== version && (observed?.policy === "unknown" ||
          (observed?.revision !== undefined && observed.revision >= accepted.revision))) return;
      this.floors.set(id, accepted.revision);
      this.views = { ...this.views, [id]: { ...view, policy, revision: accepted.revision, confirmed: false, pending: true } };
    } catch (error) {
      if (!current()) return;
      const conflict = error instanceof DeliveryPolicyError && error.reason === "revision_conflict";
      const uncertain = !(error instanceof DeliveryPolicyError) || error.uncertain;
      if ((this.versions.get(id) ?? 0) === version && noticeEpoch === (this.noticeEpochs.get(id) ?? 0)) {
        this.notices = { ...this.notices, [id]: conflict ? "別の操作で更新されました。再取得後に選び直してください" :
          uncertain ? "保存結果未確認" : "設定を保存できませんでした" };
      }
      if (conflict || uncertain) {
        await this.refresh(id, noticeEpoch === (this.noticeEpochs.get(id) ?? 0));
        if (current() && conflict && noticeEpoch === (this.noticeEpochs.get(id) ?? 0)) this.notices = { ...this.notices, [id]: "別の操作で更新されました。選び直してください" };
      }
    } finally {
      if (current()) { this.requests.delete(id); this.saving = { ...this.saving, [id]: false }; }
    }
  }
}
