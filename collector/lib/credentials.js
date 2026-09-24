const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// expiresAt: ms epoch (Claude Code'un yazdığı biçim — doğrulandı 07.09.2026).
// SÜRESİ DOLMUŞ token'ı "var" saymak, dosya kaynağını Keychain'e tercih ettiğimiz
// için sonsuz 401 üretiyordu: ~/.claude/.credentials.json'da aylar önceki bir kopya
// dururken Keychain'deki taze token hiç denenmiyordu. Artık ölü token = yok.
function parseToken(raw, now = Date.now()) {
  try {
    const creds = JSON.parse(raw);
    const o = creds && creds.claudeAiOauth;
    if (!o || typeof o.accessToken !== "string" || !o.accessToken) return null;
    if (typeof o.expiresAt === "number" && Number.isFinite(o.expiresAt) && o.expiresAt <= now) {
      return null;
    }
    return o.accessToken;
  } catch {
    return null;
  }
}

// Linux/Windows (ve bazı mac kurulumları): ~/.claude/.credentials.json
function readTokenFromFile(dir, now = Date.now()) {
  try {
    return parseToken(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8"), now);
  } catch {
    return null;
  }
}

// macOS: Claude Code token'ı Keychain'de saklar
function readTokenFromKeychain(now = Date.now()) {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }
    ).toString("utf8");
    return parseToken(raw, now);
  } catch {
    return null; // keychain kilidi/izin reddi dahil her durumda sessizce vazgeç
  }
}

// Kaynak SIRASI değil, GEÇERLİLİK önemli: süresi dolmuş bir kaynak atlanır ve
// bir sonrakine geçilir (bkz. parseToken).
function getAccessToken(dir, now = Date.now()) {
  return readTokenFromFile(dir, now) || readTokenFromKeychain(now);
}

// Token'ın NEREDEN geldiği — ping.js kullanıcıya "dosya / keychain / yok" diye bassın diye.
// Token'ın kendisini DÖNDÜRMEZ (yanlışlıkla loglanmasın).
// "süresi dolmuş": kaynak dosyada token VAR ama expiresAt geçmiş → kullanıcıya
// "claude /login" demek gerekiyor; "yok" demek yanıltıcıydı.
function tokenSource(dir, now = Date.now()) {
  if (readTokenFromFile(dir, now)) return "dosya";
  if (readTokenFromKeychain(now)) return "keychain";
  // Geçerli token bulunamadı — süresi dolmuş bir kopya var mı?
  const sonsuz = 0; // now=0 ile expiresAt kontrolü fiilen kapanır
  if (readTokenFromFile(dir, sonsuz) || readTokenFromKeychain(sonsuz)) {
    return "süresi dolmuş";
  }
  return "yok";
}

module.exports = {
  getAccessToken, readTokenFromFile, readTokenFromKeychain, parseToken, tokenSource,
};
