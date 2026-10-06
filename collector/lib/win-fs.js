// Windows: virüs tarayıcısı (Defender) ya da arama dizini yeni yazılan dosyayı
// kısa süre açık tutar; "yaz → yeniden adlandır" EPERM/EBUSY ile düşer
// (graceful-fs'in de çözdüğü bilinen sorun). Yalnız Windows'ta, en fazla
// ~1 sn kısa beklemelerle yeniden dener. Yan etkili modül: lib/config.js,
// lib/runtime.js ve lib/file-lock.js yükler, böylece her giriş noktası kapsanır.
// Diğer sistemlerde hiçbir şey yapmaz.
//
// NOT (modül biçimi): CommonJS. `apply` testte sahte fs ile çağrılır.
const fs = require("fs");

const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function apply(target = fs, { platform = process.platform, sleep } = {}) {
  if (platform !== "win32" || target.renameSync.__usagexRetry) return target;
  const orig = target.renameSync;
  const wait = sleep || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const renameSync = function renameSync(from, to) {
    let ms = 10;
    for (let i = 0; ; i++) {
      try { return orig.call(target, from, to); }
      catch (e) {
        if (i >= 8 || !e || !RETRY_CODES.has(e.code)) throw e;
        wait(ms);
        ms = Math.min(ms * 2, 200);
      }
    }
  };
  renameSync.__usagexRetry = true;
  target.renameSync = renameSync;
  return target;
}

apply();

module.exports = { apply, RETRY_CODES };
