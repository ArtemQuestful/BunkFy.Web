import { chromium, type Browser } from "@playwright/test";
import { expect, it } from "vitest";
import { launchNativeChromium } from "./support/nativeChromium";

it("preserves the installed Playwright feature defaults in the native browser", async () => {
  const baseline = await chromium.launch({ headless: true, args: ["--enable-automation"] });
  let native: Browser | undefined;
  try {
    const baselineSession = await baseline.newBrowserCDPSession();
    const original = await baselineSession.send("Browser.getBrowserCommandLine") as { arguments: string[] };
    const originalValue = original.arguments.filter(value => value.startsWith("--disable-features=")).at(-1);
    expect(originalValue).toBeDefined();
    const expected = new Set(originalValue!.slice("--disable-features=".length).split(","));
    if (process.platform === "win32") expected.add("TcpPortRandomizationWin");

    native = await launchNativeChromium({ exposeCommandLine: true });
    const nativeSession = await native.newBrowserCDPSession();
    const actual = await nativeSession.send("Browser.getBrowserCommandLine") as { arguments: string[] };
    const effectiveValue = actual.arguments.filter(value => value.startsWith("--disable-features=")).at(-1);
    expect(effectiveValue).toBeDefined();
    expect(new Set(effectiveValue!.slice("--disable-features=".length).split(","))).toEqual(expected);
    expect(await native.version()).toBe(await baseline.version());
  } finally {
    await native?.close();
    await baseline.close();
  }
}, 60000);
