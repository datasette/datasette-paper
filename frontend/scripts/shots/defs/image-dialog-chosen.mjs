import { defineShot } from "../defineShot.mjs";

// The insert-image dialog with a file chosen (preview + enabled Insert). No
// freeze (no volatile text).
export default defineShot({
  name: "image-dialog-chosen",
  order: 30,
  doc: "richId",
  freeze: false,
  prepare: async (page) => {
    await page.locator('.paper-toolbar [aria-label="Insert image"]').click();
    const dialog = page.locator("dialog.image-dialog");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog.locator(".img-tab", { hasText: "Upload from computer" }).click();
    // A real SVG so the preview + Insert (enabled) state is exercised.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">' +
      '<rect width="320" height="180" fill="#0b5cad"/>' +
      '<text x="160" y="103" font-family="sans-serif" font-size="22" fill="#fff" text-anchor="middle">diagram.svg</text></svg>';
    await page.setInputFiles(".image-upload-input", {
      name: "diagram.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from(svg),
    });
    await dialog.locator(".image-preview").waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) => page.locator("dialog.image-dialog").screenshot({ path: file }),
});
