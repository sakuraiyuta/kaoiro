import { describe, it, expect } from "vitest";
import rawIndexHtml from "../index.html?raw";
import rawManifest from "../public/manifest.webmanifest?raw";

describe("Web App Manifest and Header Icon", () => {
  it("index.html contains manifest link and theme-color meta tag", () => {
    expect(rawIndexHtml).toMatch(/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"/);
    expect(rawIndexHtml).toMatch(/<meta\s+name="theme-color"\s+content="#14141d"/);
  });

  it("manifest.webmanifest is valid and declares required PWA metadata and icons", () => {
    const content = JSON.parse(rawManifest);

    expect(content.name).toBe("kaoiro");
    expect(content.short_name).toBe("kaoiro");
    expect(content.display).toBe("standalone");
    expect(content.start_url).toBe("/");
    expect(content.background_color).toBe("#14141d");
    expect(content.theme_color).toBe("#14141d");

    expect(Array.isArray(content.icons)).toBe(true);
    expect(content.icons).toEqual([
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ]);
  });
});
