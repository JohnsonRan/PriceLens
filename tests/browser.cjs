// Locate isolated test browsers: explicit env var first, then a Playwright cache on Windows or Linux.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const caches = [path.join(os.homedir(), "AppData/Local/ms-playwright"), path.join(os.homedir(), ".cache/ms-playwright"), process.env.PLAYWRIGHT_BROWSERS_PATH].filter(Boolean);
const layouts = {
  // headless shell: DOM fixtures; full Chromium: unpacked MV3 extension (headless shell cannot load extensions).
  shell: { dir: /^chromium_headless_shell-\d+$/, files: ["chrome-headless-shell-win64/chrome-headless-shell.exe", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell"] },
  full: { dir: /^chromium-\d+$/, files: ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux64/chrome", "chrome-linux/chrome"] },
};

function find(kind, envVar) {
  if (process.env[envVar] && fs.existsSync(process.env[envVar])) return process.env[envVar];
  const { dir, files } = layouts[kind];
  for (const cache of caches) {
    if (!fs.existsSync(cache)) continue;
    const builds = fs.readdirSync(cache).filter((n) => dir.test(n)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const build of builds) for (const file of files) {
      const exe = path.join(cache, build, file);
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

// Linux CI runners (AppArmor user-namespace limits) cannot start Chromium's sandbox; these are throwaway local-fixture profiles.
const platformFlags = process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : [];

module.exports = { shellBrowser: () => find("shell", "CHROME_BIN"), fullBrowser: () => find("full", "MV3_CHROME_BIN"), platformFlags };
