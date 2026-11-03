import { chromium, type Browser } from "@playwright/test";

let windowsDefaults: Promise<string[]> | undefined;

async function readInstalledFeatureDefaults(): Promise<string[]> {
  // Only this short-lived diagnostic probe needs the CDP command-line opt-in.
  const probe = await chromium.launch({ headless: true, args: ["--enable-automation"] });
  try {
    const session = await probe.newBrowserCDPSession();
    const commandLine = await session.send("Browser.getBrowserCommandLine") as { arguments: string[] };
    const featureArgument = commandLine.arguments.filter(value => value.startsWith("--disable-features=")).at(-1);
    if (!featureArgument) throw new Error("Installed Chromium did not expose Playwright's feature defaults.");
    return featureArgument.slice("--disable-features=".length).split(",").filter(Boolean);
  } finally {
    await probe.close();
  }
}

// Windows loopback connections can fail with WSAENOBUFS even with free ports:
// https://github.com/microsoft/playwright/issues/43545
// A bare --disable-features replaces Playwright's defaults, including its
// interception/storage workarounds (#43557). Read the installed defaults via
// public CDP instead of copying a version-specific list or importing internals.
// This affects only synthetic native tests, never the application/browser build.
export async function launchNativeChromium(
  { exposeCommandLine = false }: { exposeCommandLine?: boolean } = {},
): Promise<Browser> {
  // The defaults-preservation test opts into public CDP inspection; fixtures do not.
  const diagnosticArgs = exposeCommandLine ? ["--enable-automation"] : [];
  if (process.platform !== "win32") return chromium.launch({ headless: true, args: diagnosticArgs });
  windowsDefaults ??= readInstalledFeatureDefaults();
  const defaults = await windowsDefaults;
  if (defaults.includes("TcpPortRandomizationWin")) return chromium.launch({ headless: true, args: diagnosticArgs });
  return chromium.launch({
    headless: true,
    args: [...diagnosticArgs, `--disable-features=${[...defaults, "TcpPortRandomizationWin"].join(",")}`],
  });
}
