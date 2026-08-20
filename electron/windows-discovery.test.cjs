const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  appIdFromExecutable,
  desktopCandidatesFromCli,
  isClaudeCliPath,
  isClaudeDesktopAlias,
  packageExecutableCandidates,
  parsePowerShellJson,
  registeredExecutableCandidates,
  startAppId,
} = require("./windows-discovery.cjs");

test("derives the Claude AppUserModelID from a running MSIX executable", () => {
  const executable = String.raw`C:\Program Files\WindowsApps\Claude_1.32885.1.0_x64__pzs8sxrjxfjjc\app\Claude.exe`;
  assert.equal(appIdFromExecutable("claude", executable), "Claude_pzs8sxrjxfjjc!Claude");
  assert.equal(appIdFromExecutable("codex", executable), null);
});

test("infers the packaged Codex desktop executables from its bundled CLI", () => {
  const cli = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_1.2.3_x64__id\app\resources\codex.exe`;
  assert.deepEqual(desktopCandidatesFromCli("codex", cli), [
    path.normalize(String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_1.2.3_x64__id\app\ChatGPT.exe`),
    path.normalize(String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_1.2.3_x64__id\app\Codex.exe`),
  ]);
});

test("does not mistake the Claude Desktop execution alias for Claude Code", () => {
  const alias = String.raw`C:\Users\demo\AppData\Local\Microsoft\WindowsApps\Claude.exe`;
  assert.equal(isClaudeDesktopAlias(alias), true);
  assert.equal(isClaudeCliPath(alias), false);
  assert.equal(isClaudeCliPath(String.raw`C:\Users\demo\AppData\Roaming\npm\claude.cmd`), true);
  assert.equal(isClaudeCliPath(String.raw`C:\Users\demo\.local\bin\claude.exe`), true);
});

test("builds executable candidates and launch ids from AppX metadata", () => {
  const metadata = parsePowerShellJson(JSON.stringify({
    packages: { name: "Claude", familyName: "Claude_publisher", installLocation: String.raw`C:\Program Files\WindowsApps\Claude_1.0_x64__publisher` },
    startApps: { name: "Claude", appId: "Claude_publisher!Claude" },
  }));
  assert.deepEqual(packageExecutableCandidates("claude", metadata.packages), [
    path.normalize(String.raw`C:\Program Files\WindowsApps\Claude_1.0_x64__publisher\app\Claude.exe`),
    path.normalize(String.raw`C:\Program Files\WindowsApps\Claude_1.0_x64__publisher\Claude.exe`),
  ]);
  assert.equal(startAppId("claude", metadata.startApps), "Claude_publisher!Claude");
});

test("uses uninstall registration paths for non-default installations", () => {
  assert.deepEqual(registeredExecutableCandidates("claude", [{
    name: "Claude Desktop",
    installLocation: String.raw`D:\Apps\Claude`,
    displayIcon: String.raw`"D:\Apps\Claude\Claude.exe",0`,
  }]), [
    String.raw`D:\Apps\Claude\Claude.exe`,
  ]);
});
