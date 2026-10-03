import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Web App Manifest and Header Icon", () => {
  it("index.html contains manifest link and theme-color meta tag", () => {
    const indexPath = resolve(__dirname, "../index.html");
    const html = readFileSync(indexPath, "utf-8");

    expect(html).toMatch(/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"/);
    expect(html).toMatch(/<meta\s+name="theme-color"\s+content="#14141d"/);
  });

  it("manifest.webmanifest is valid and declares required PWA metadata and icons", () => {
    const manifestPath = resolve(__dirname, "../public/manifest.webmanifest");
    const content = JSON.parse(readFileSync(manifestPath, "utf-8"));

    expect(content.name).toBe("kaoiro");
    expect(content.short_name).toBe("kaoiro");
    expect(content.display).toBe("standalone");
    expect(content.start_url).toBe("/");
    expect(content.background_color).toBe("#14141d");
    expect(content.theme_color).toBe("#14141d");

    expect(Array.isArray(content.icons)).toBe(true);
    expect(content.icons).toHaveLength(4);

    const iconPaths = content.icons.map((i: { src: string }) => i.src);
    expect(iconPaths).toContain("/icons/icon-192.png");
    expect(iconPaths).toContain("/icons/icon-512.png");
    expect(iconPaths).toContain("/icons/icon-maskable-192.png");
    expect(iconPaths).toContain("/icons/icon-maskable-512.png");
  });
});
