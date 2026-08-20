const test = require("node:test");
const assert = require("node:assert/strict");
const { emptySettings, normalizeSettings, validateSettings } = require("./settings.cjs");

test("normalizes settings and strips pasted quotes", () => {
  const settings = normalizeSettings({ providers: { claude: { desktopPath: '  "C:\\Apps\\Claude.exe"  ' } } });
  assert.equal(settings.providers.claude.desktopPath, "C:\\Apps\\Claude.exe");
  assert.deepEqual(settings.providers.codex, emptySettings().providers.codex);
});

test("validates files and data directories independently", async () => {
  const fakeStat = async (target) => ({
    isFile: () => target.endsWith(".exe"),
    isDirectory: () => !target.endsWith(".exe"),
  });
  const result = await validateSettings({
    providers: {
      codex: { desktopPath: "C:\\Apps\\Codex.exe", dataHome: "C:\\Data\\Codex" },
      claude: { cliPath: "C:\\Apps\\Claude" },
    },
  }, { platform: "win32", stat: fakeStat });
  assert.equal(result.valid, false);
  assert.equal(result.errors["claude.cliPath"], "请选择可执行文件");
  assert.equal(result.errors["codex.desktopPath"], undefined);
  assert.equal(result.errors["codex.dataHome"], undefined);
});

test("accepts macOS app bundles as desktop applications", async () => {
  const fakeStat = async (target) => ({
    isFile: () => target.endsWith("/claude"),
    isDirectory: () => target.endsWith(".app"),
  });
  const accepted = await validateSettings({
    providers: {
      codex: { desktopPath: "/Applications/Codex.app" },
      claude: { desktopPath: "/Applications/Claude.app" },
    },
  }, { platform: "darwin", stat: fakeStat });
  assert.equal(accepted.valid, true);

  const rejected = await validateSettings({
    providers: { claude: { desktopPath: "/Applications/Claude" } },
  }, { platform: "darwin", stat: fakeStat });
  assert.equal(rejected.errors["claude.desktopPath"], "请选择可执行文件或 .app 应用");
});
