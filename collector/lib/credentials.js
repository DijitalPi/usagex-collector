const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function parseToken(raw) {
  try {
    const creds = JSON.parse(raw);
    return (creds && creds.claudeAiOauth && creds.claudeAiOauth.accessToken) || null;
  } catch {
    return null;
  }
}

// Linux/Windows (ve bazı mac kurulumları): ~/.claude/.credentials.json
function readTokenFromFile(dir) {
  try {
    return parseToken(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8"));
  } catch {
    return null;
  }
}

// macOS: Claude Code token'ı Keychain'de saklar
function readTokenFromKeychain() {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }
    ).toString("utf8");
    return parseToken(raw);
  } catch {
    return null; // keychain kilidi/izin reddi dahil her durumda sessizce vazgeç
  }
}

function getAccessToken(dir) {
  return readTokenFromFile(dir) || readTokenFromKeychain();
}

module.exports = { getAccessToken, readTokenFromFile, readTokenFromKeychain, parseToken };
