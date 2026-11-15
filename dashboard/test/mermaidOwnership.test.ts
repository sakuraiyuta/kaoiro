// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const { render } = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render } }));
beforeEach(() => { vi.resetModules(); render.mockReset(); });
afterEach(() => { document.body.innerHTML = ""; });
function body() {
  const root = document.createElement("div");
  root.innerHTML = '<pre><code class="language-mermaid">graph TD;A-->B</code></pre>';
  document.body.append(root); return root;
}
it("checks ownership after the lazy import before starting a diagram", async () => {
  const { renderMermaidIn } = await import("../src/lib/markdown");
  const root = body(); let current = true;
  const job = renderMermaidIn(root, () => current); current = false;
  await job;
  expect(render).not.toHaveBeenCalled();
  expect(root.querySelector("pre")).not.toBeNull();
});
it("checks ownership after rendering before touching the current DOM", async () => {
  const { renderMermaidIn } = await import("../src/lib/markdown");
  let finish!: (v: { svg: string }) => void;
  render.mockImplementation(() => new Promise(r => { finish = r; }));
  const root = body(); let current = true;
  const job = renderMermaidIn(root, () => current);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  current = false; finish({ svg: '<svg><text>old</text></svg>' }); await job;
  expect(root.querySelector("svg")).toBeNull();
  expect(root.querySelector("pre")).not.toBeNull();
});
it("sanitizes generated SVG and cleans a failed diagram without losing source", async () => {
  const { renderMermaidIn } = await import("../src/lib/markdown");
  render.mockResolvedValue({ svg: '<svg onload="bad()"><text>ok</text></svg>' });
  const root = body(); await renderMermaidIn(root);
  expect(root.querySelector("svg")?.getAttribute("onload")).toBeNull();
  expect(root.querySelector("text")?.textContent).toBe("ok");
  render.mockImplementation((id: string) => {
    const orphan = document.createElement("div"); orphan.id = `d${id}`;
    document.body.append(orphan); throw Error("invalid diagram");
  });
  const bad = body(); await renderMermaidIn(bad);
  expect(bad.querySelector("code")?.textContent).toBe("graph TD;A-->B");
  expect(document.querySelector('[id^="dkaoiro-mmd-"]')).toBeNull();
});
