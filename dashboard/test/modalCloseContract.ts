import "./isolation.setup";
import { expect, it, type Mock } from "vitest";

export function installDialogShim(): void {
  if (
    typeof HTMLDialogElement !== "undefined" &&
    typeof HTMLDialogElement.prototype.showModal !== "function"
  ) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }
}

export function testModalCloseContract(
  render: () => Promise<{ target: HTMLElement; onClose: Mock }>,
): void {
  it("closes on a dialog backdrop click", async () => {
    const { target, onClose } = await render();
    target.querySelector<HTMLElement>("dialog")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on an inner click", async () => {
    const { target, onClose } = await render();
    target.querySelector<HTMLElement>("h2")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes and prevents the default on cancel", async () => {
    const { target, onClose } = await render();
    const event = new Event("cancel", { cancelable: true });
    target.querySelector<HTMLDialogElement>("dialog")!.dispatchEvent(event);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
}
