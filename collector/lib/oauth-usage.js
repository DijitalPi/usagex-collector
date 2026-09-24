const fs = require("fs");
const path = require("path");
const { claudeDir } = require("./config");
const { getAccessToken } = require("./credentials");

// UNDOCUMENTED endpoint — Anthropic her an değiştirebilir. Bu modül kırılırsa
// payload plan_usage=null ile devam eder; transcript bazlı veri akışı etkilenmez.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CACHE_TTL_MS = 5 * 60 * 1000; // varsayılan tazelik penceresi (poll/backfill gibi pasif yollar)
// Oturum AKTİFKEN (Stop hook'u geliyorsa) daha kısa pencere: eşik bildirimleri
// 5 dk'lık cache yüzünden geç kalıyordu — kullanıcı %90'ı geçtiğinde uyarı ancak
// bir sonraki tazelemede gidiyordu. Çağıran `ttlMs` ile bunu indirir
// (hooks/heartbeat.js 120000 geçer). FORCE_MIN_AGE_MS (60 sn) alt sınır olarak
// durduğu için uç yine dakikada birden fazla dövülmez.
const TIMEOUT_MS = 3000;
// Uç SERT sınırlı: ölçüldü — arka arkaya birkaç istekte HTTP 429 + retry-after ~246 sn.
// force:true her oturum KAPANIŞINDA cache'i atladığı için, dakikada birkaç oturum
// kapatan bir kurulumda (otomasyon/pipeline) uç sürekli dövülüyor ve 429 yüzünden
// limit verisi büsbütün kayboluyordu. İki fren:
const FORCE_MIN_AGE_MS = 60 * 1000;   // force olsa bile 60 sn'den taze cache'i tekrar sorma
const DEFAULT_BACKOFF_MS = 5 * 60 * 1000; // retry-after yoksa varsayılan bekleme
const MAX_BACKOFF_MS = 60 * 60 * 1000;    // sunucu absürt bir değer verirse tavan
// 401/403 (token süresi doldu) ve 5xx (uç geçici bozuk): 429'un HAFİF hâli.
// Her hook'ta 3 sn'lik timeout'a girip beklemek yerine kısa bir pencere boyunca hiç sorma.
const ERROR_BACKOFF_MS = 60 * 1000;
// UYARLANABİLİR TEMPO: aktif oturumda tazelik penceresi 2 dk'ya indiriliyor
// (bildirim gecikmesi için). Ama bu tempo bazı kurulumlarda 429'u BESLİYOR:
// back-off bitiyor, 2 dk sonra tekrar soruluyor, yine 429… Çözüm, 429'u gördüğümüz
// anı cache'e yazmak (last_429_at) ve o andan sonraki 60 dk boyunca kısa pencereye
// İNMEMEK — TTL de heartbeat aralığı da 5 dk'ya geri düşer. Pencere dolunca kendi
// kendine 2 dk'ya döner (elle sıfırlama yok).
const R429_WINDOW_MS = 60 * 60 * 1000;

function cachePathFor(dir) {
  return path.join(dir, "usagex-usage-cache.json");
}

// Son R429_WINDOW_MS içinde 429 yedik mi? (cache dosyasından okunur — hook'lar
// arası tek durum kaynağı orası). `cached` verilirse dosya tekrar okunmaz.
function recently429({ dir, now = Date.now, cached = null } = {}) {
  let c = cached;
  if (!c) {
    try { if (!dir) dir = claudeDir(); } catch { return false; }
    c = readCache(cachePathFor(dir));
  }
  const ts = c && typeof c.last_429_at === "number" ? c.last_429_at : null;
  if (ts == null) return false;
  const yas = now() - ts;
  // yas < 0: saat geri alınmış — damgayı "taze" sayıp sonsuza dek yavaşlatmayalım
  return yas >= 0 && yas < R429_WINDOW_MS;
}

// Cache'e yazarken 429 damgası KORUNUR: araya giren başarılı bir istek pencereyi
// sıfırlarsa uyarlanabilir tempo hiç tutmaz (bir başarı, sınırın kalktığı anlamına
// gelmez). Damga zaten yaşlanarak kendi kendine düşer.
function korunan429(cached) {
  return cached && typeof cached.last_429_at === "number"
    ? { last_429_at: cached.last_429_at }
    : {};
}

function readCache(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function writeCache(p, obj) {
  const tmp = `${p}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 }); fs.renameSync(tmp, p); } catch { try { fs.unlinkSync(tmp); } catch {} }
}

// FLOOR, round DEĞİL: %99.5 kullanım "%100" olarak gösterilince kullanıcı limiti
// bitmiş sanıp çalışmayı bırakıyordu. Aşağı yuvarlamak "henüz bitmedi"yi korur.
// (app tarafındaki ClaudeConnect.pct de aynı kurala çekiliyor — APP2.)
function pct(win) {
  if (!win || typeof win.utilization !== "number") return null;
  return Math.min(100, Math.max(0, Math.floor(win.utilization)));
}

// Model bazlı HAFTALIK limitler (ör. "Claude Design" satırı). Uç bunları
// `limits[]` altında veriyor; collector hiç okumuyordu, yalnız telefondaki
// gömülü tarayıcı okuyordu — bilgisayardan gelen veride bu kırılım yoktu.
// Kural app'teki ClaudeConnect.toPlanUsage ile BİREBİR aynı tutuldu.
function scopedLimits(data) {
  const list = Array.isArray(data && data.limits) ? data.limits : [];
  return list
    .filter((l) => l && l.group === "weekly" && l.scope && l.scope.model && l.scope.model.display_name)
    .map((l) => ({
      model: l.scope.model.display_name,
      percent: typeof l.percent === "number"
        ? Math.min(100, Math.max(0, Math.floor(l.percent)))
        : null,
      resets_at: l.resets_at || null,
    }));
}

// Ölçüm zamanı: sunucu snapshot'ı "şimdi" damgasıyla yazıyordu, oysa cache'ten
// dönen yüzde 5 dakika eski olabiliyordu. measured_at ile sunucu taken_at'i
// gerçeğe göre yazabilir (bkz. SERVER2 notu).
function withMeasuredAt(plan_usage, ts) {
  if (!plan_usage || typeof plan_usage !== "object") return null;
  const gecerli = Number.isFinite(ts) && ts > 0;
  return { ...plan_usage, measured_at: gecerli ? new Date(ts).toISOString() : null };
}

// Back-off penceresinde 5 dk'dan eski okuma: null yerine SON BİLİNEN değeri döndür,
// ama `stale: true` ile işaretle. null'da sunucu hiç snapshot yazmıyor, yani veri
// büsbütün kayboluyordu; işaretli eski değer hiç yoktan iyidir. (Sunucu bu alanı
// tanımıyorsa yok sayar — şema kırılmaz.)
function staleCopy(plan_usage, ts) {
  if (!plan_usage || typeof plan_usage !== "object") return null;
  return { ...withMeasuredAt(plan_usage, ts), stale: true };
}

async function getPlanUsageUnlocked({
  dir, fetchImpl = fetch, now = Date.now, force = false, ttlMs = CACHE_TTL_MS,
} = {}) {
  // Bozuk/negatif ttlMs varsayılana düşer (çağıran yanlış değer verse de cache çalışsın).
  const istenenTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : CACHE_TTL_MS;
  try {
    if (!dir) dir = claudeDir();
  } catch {
    return null;
  }
  const cachePath = cachePathFor(dir);
  const cached = readCache(cachePath);
  // Son 60 dk içinde 429 gördüysek KISA pencereye inmeyiz: çağıranın istediği TTL
  // ne olursa olsun en az 5 dk (CACHE_TTL_MS). Uzatan bir değer verilmişse ona dokunulmaz.
  const ttl = recently429({ now, cached })
    ? Math.max(istenenTtl, CACHE_TTL_MS)
    : istenenTtl;
  // fetched_at <= now: saat geri alınırsa (skew) gelecekteki damga bayat cache'i
  // sonsuza dek taze göstermesin.
  const age = cached && typeof cached.fetched_at === "number" ? now() - cached.fetched_at : Infinity;
  const tazeMi = (sinir) => age >= 0 && age < sinir;

  // force: cache atlanır (oturum SONU gönderimi için — eşik tam kapanışta
  // geçildiyse 5 dk'lık cache eski yüzdeyi taşır ve taze veri bir daha gelmez).
  // Ama 60 sn'den taze bir okuma varken tekrar sormanın bilgi değeri yok, 429
  // riski var: o durumda force da cache'i kullanır.
  // Ağa çıkma kararı `ttl` ile verilir (çağıran kısaltabilir); aşağıdaki
  // back-off yollarında BAYATLIK ölçüsü CACHE_TTL_MS olarak KALIR — kısa TTL
  // yüzünden 429 penceresinde elde olan okuma "stale" damgalanıp düşürülmesin.
  if (tazeMi(force ? FORCE_MIN_AGE_MS : ttl)) {
    return withMeasuredAt(cached.plan_usage, cached.fetched_at);
  }

  // 429 back-off penceresi: force olsa bile isteğe ÇIKMA — üstüne gitmek pencereyi
  // uzatır. Elde makul tazelikte bir okuma varsa onu döndür (null'dan iyidir:
  // sunucu null'da hiç snapshot yazmıyor, yani veri tamamen kayboluyordu).
  if (cached && typeof cached.blocked_until === "number" && now() < cached.blocked_until) {
    return tazeMi(CACHE_TTL_MS)
      ? withMeasuredAt(cached.plan_usage, cached.fetched_at)
      : staleCopy(cached.plan_usage, cached.fetched_at);
  }

  const token = getAccessToken(dir);
  if (!token) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          // Identify the collector honestly; do not impersonate Claude Code.
          "User-Agent": `usagex-collector/${require("../package.json").version}`,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      // Sunucunun söylediği süre kadar bekle; söylemediyse varsayılan.
      const ra = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
      const bekle = Number.isFinite(ra) && ra > 0
        ? Math.min(ra * 1000, MAX_BACKOFF_MS)
        : DEFAULT_BACKOFF_MS;
      // Son bilinen okumayı KORU (fetched_at'e dokunma — tazeliği hakkında yalan söyleme),
      // yalnız "şu ana kadar sorma" damgasını yaz.
      // last_429_at: uyarlanabilir tempo damgası — bundan sonraki 60 dk boyunca
      // hem TTL hem heartbeat aralığı 5 dk'ya çekilir (bkz. R429_WINDOW_MS).
      writeCache(cachePath, {
        fetched_at: cached && typeof cached.fetched_at === "number" ? cached.fetched_at : 0,
        plan_usage: cached ? cached.plan_usage : null,
        blocked_until: now() + bekle,
        last_429_at: now(),
      });
      return tazeMi(CACHE_TTL_MS)
        ? withMeasuredAt(cached.plan_usage, cached.fetched_at)
        : staleCopy(cached && cached.plan_usage, cached && cached.fetched_at);
    }
    // 401/403 (token bayat) ve 5xx (uç geçici bozuk): 60 sn'lik kısa pencere.
    // 4xx'in geri kalanı (ör. 404 = uç kalktı) da aynı frene girer; kalıcıysa
    // pencere her dolduğunda bir kez denenip yeniden kapanır.
    if (!res.ok) {
      writeCache(cachePath, {
        fetched_at: cached && typeof cached.fetched_at === "number" ? cached.fetched_at : 0,
        plan_usage: cached ? cached.plan_usage : null,
        blocked_until: now() + ERROR_BACKOFF_MS,
        ...korunan429(cached),
      });
      return tazeMi(CACHE_TTL_MS)
        ? withMeasuredAt(cached.plan_usage, cached.fetched_at)
        : staleCopy(cached && cached.plan_usage, cached && cached.fetched_at);
    }
    const data = await res.json();
    let plan_usage = {
      session_pct: pct(data.five_hour),
      week_pct: pct(data.seven_day),
      session_resets_at: (data.five_hour && data.five_hour.resets_at) || null,
      week_resets_at: (data.seven_day && data.seven_day.resets_at) || null,
      scoped: scopedLimits(data),
    };
    // Format değişmiş/boş cevap: null'a düş. null da cache'lenir — tazelik
    // penceresi (ttl: varsayılan 5 dk, oturum aktifken 2 dk) boyunca tekrar sorulmaz.
    if (plan_usage.session_pct === null && plan_usage.week_pct === null) plan_usage = null;
    const olcumZamani = now();
    // Cache'e measured_at YAZILMAZ: fetched_at zaten o bilgiyi taşıyor, iki yerde
    // tutmak eskiyen kopyalarda çelişki üretirdi.
    try {
      fs.writeFileSync(
        cachePath,
        // Başarılı istek 429 damgasını SİLMEZ: bir istek geçti diye sınır kalkmış
        // olmuyor, damga 60 dk'da kendi kendine yaşlanıp düşer.
        JSON.stringify({ fetched_at: olcumZamani, plan_usage, ...korunan429(cached) }),
        { mode: 0o600 }
      );
    } catch {}
    return withMeasuredAt(plan_usage, olcumZamani);
  } catch {
    return null;
  }
}

async function getPlanUsage(opts = {}) {
  let dir; try { dir = opts.dir || claudeDir(); } catch { return null; }
  const release = require("./file-lock").acquire(cachePathFor(dir) + ".lock");
  if (!release) {
    const cached = readCache(cachePathFor(dir));
    return cached ? staleCopy(cached.plan_usage, cached.fetched_at) : null;
  }
  try { return await getPlanUsageUnlocked({ ...opts, dir }); } finally { release(); }
}

module.exports = { getPlanUsage, recently429, CACHE_TTL_MS, R429_WINDOW_MS };
