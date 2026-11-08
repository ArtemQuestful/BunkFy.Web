import type { Browser } from "@playwright/test";

/** Compile the isolated Vite fixture before measuring its unchanged UI contracts. */
export async function warmNativeFixture(browser: Browser, url: string): Promise<void> {
  const page = await browser.newPage();
  try {
    const response = await page.goto(url, { timeout: 30_000, waitUntil: "load" });
    if (!response?.ok()) throw new Error("The native browser fixture did not start successfully.");
  } finally {
    await page.close();
  }
}
