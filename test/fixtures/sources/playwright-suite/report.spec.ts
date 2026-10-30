import { expect, test } from "@playwright/test";

const checkoutPage = `<!doctype html>
<html lang="en">
  <body>
    <h1>Checkout</h1>
    <button type="button" onclick="document.querySelector('output').textContent = 'Order placed'">Place order</button>
    <output></output>
  </body>
</html>`;

test("places an order", async ({ page }) => {
  await page.setContent(checkoutPage);
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.locator("output")).toHaveText("Order placed");
});

test("shows the order confirmation number", async ({ page }) => {
  await page.setContent(checkoutPage);
  await page.getByRole("button", { name: "Place order" }).click();
  // Intentionally fails so reporters capture a screenshot, video and trace.
  await expect(page.locator("output")).toHaveText("Order #1001 placed", { timeout: 500 });
});

test("attaches a large diagnostic dump", async ({ page }, testInfo) => {
  await page.setContent(checkoutPage);
  // Binary and larger than the reporting-labs 2 MB embedLimit, so it is written to assets/
  // (text attachments are always inlined and truncated).
  const dump = Buffer.alloc(3 * 1024 * 1024);
  for (let index = 0, state = 1; index < dump.length; index += 1) {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    dump[index] = state >>> 24;
  }
  await testInfo.attach("diagnostics.bin", { body: dump, contentType: "application/octet-stream" });
});
