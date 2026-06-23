/**
 * E2E for image support: inserting an image via the toolbar dialog, and the
 * overflow CSS that keeps a large image inside the document width.
 *
 * Clipboard image *paste* (the Safari fix) is covered by unit tests in
 * src/lib/__tests__/image.test.ts — synthesizing a real clipboard image event
 * across browsers in Playwright is unreliable, so the pure helper is tested
 * directly and the EditorView wiring is a thin one-liner.
 */
import { test, expect } from "@playwright/test";
import { createPaper, gotoPaper } from "./helpers";

// A 1x1 transparent PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test.describe("image insert dialog", () => {
  test("uploads an image and inserts it into the document", async ({ page }) => {
    const doc = await createPaper(page);
    await gotoPaper(page, doc.url);

    // Open the dialog from the toolbar.
    await page.locator('.paper-toolbar [aria-label="Insert image"]').click();
    const dialog = page.locator("dialog.image-dialog");
    await expect(dialog).toBeVisible();

    // Empty state: Insert is disabled, no preview yet.
    await expect(dialog.locator(".image-insert-btn")).toBeDisabled();
    await expect(dialog.locator(".image-preview")).toHaveCount(0);

    // Upload tab → choose a file → preview appears and Insert enables.
    await dialog.locator(".img-tab", { hasText: "Upload from computer" }).click();
    await page.setInputFiles(".image-upload-input", {
      name: "kitten.png",
      mimeType: "image/png",
      buffer: Buffer.from(PNG_B64, "base64"),
    });
    await expect(dialog.locator(".image-preview")).toBeVisible();
    const insert = dialog.locator(".image-insert-btn");
    await expect(insert).toBeEnabled();
    await insert.click();

    // The dialog closes and an image node now lives in the document with a
    // data: URI src (no upload backend — images are inline data URIs). Skip
    // ProseMirror's internal `.ProseMirror-separator` <img>.
    await expect(dialog).toBeHidden();
    const img = page.locator(".ProseMirror img:not(.ProseMirror-separator)");
    await expect(img).toHaveCount(1);
    await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/);
  });
});

test.describe("large image overflow", () => {
  test("a wide image is constrained to the document width", async ({ page }) => {
    const doc = await createPaper(page);
    await gotoPaper(page, doc.url);

    // Insert a 2000px-wide SVG image through the dialog (the real insert path).
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="300"><rect width="2000" height="300" fill="#4a9eff"/></svg>`;
    await page.locator('.paper-toolbar [aria-label="Insert image"]').click();
    const dialog = page.locator("dialog.image-dialog");
    await dialog.locator(".img-tab", { hasText: "Upload from computer" }).click();
    await page.setInputFiles(".image-upload-input", {
      name: "wide.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from(svg),
    });
    await dialog.locator(".image-insert-btn").click();
    await expect(dialog).toBeHidden();

    const img = page.locator(".ProseMirror img:not(.ProseMirror-separator)");
    await expect(img).toHaveCount(1);
    // Rendered width must not exceed the editor's content width despite the
    // image's 2000px intrinsic width (the max-width:100% rule).
    const { imgW, hostW } = await page.evaluate(() => {
      const i = document.querySelector(
        ".ProseMirror img:not(.ProseMirror-separator)",
      ) as HTMLImageElement;
      const host = document.querySelector(".ProseMirror") as HTMLElement;
      return {
        imgW: i.getBoundingClientRect().width,
        hostW: host.getBoundingClientRect().width,
      };
    });
    expect(imgW).toBeGreaterThan(0);
    expect(imgW).toBeLessThanOrEqual(hostW + 1);
  });
});
