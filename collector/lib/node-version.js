// Collector'ın taban gereksinimi: Node 18.
// Neden 18: global `fetch` (sender, oauth-usage, connect) ilk kez 18'de geldi ve
// 16'da `AbortController`/`fetch` yok — hook sessizce ReferenceError'a düşüp her
// oturumda hiçbir şey göndermiyordu, kullanıcı da bunu göremiyordu (hook çıktısı
// yutuluyor). Kurulum anında bir kez söylemek, sessiz veri kaybından iyidir.
const MIN_MAJOR = 18;

// Sorun varsa kullanıcıya gösterilecek metni, yoksa null döner.
function nodeVersionProblem(sürüm = process.versions.node) {
  const major = parseInt(String(sürüm).split(".")[0], 10);
  if (!Number.isFinite(major)) return null; // sürüm okunamadı — engelleme, devam et
  if (major >= MIN_MAJOR) return null;
  return (
    `Node ${sürüm} kullanılıyor; UsagEX collector Node ${MIN_MAJOR} veya üstünü ister ` +
    "(global fetch bu sürümde geldi).\n" +
    "  Node'u güncelleyip tekrar deneyin: https://nodejs.org"
  );
}

module.exports = { nodeVersionProblem, MIN_MAJOR };
