const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// Kaynakta GÖRÜNMEZ karakter olmasın. Gerçek bir hata bu testi doğurdu: bir
// düzenlemede `.join(" ")` yerine dosyaya NUL bayt kaçtı; kod ekranda doğru
// görünüyor, gözden geçirmede fark edilmiyor, ama davranış sessizce değişiyordu.
// Aynı tuzak NBSP (0xA0) ve sıfır genişlikli karakterlerde de var: bunlar
// dizgi karşılaştırmalarını ve regex'leri kimseye görünmeden bozar.
// Kaçış dizisiyle YAZMAK serbest (kaynakta iki karakter: ters bölü + u0000);
const YASAK = new Map([
  [0x0000, "NUL"],
  [0x00a0, "kırılmaz boşluk (NBSP)"],
  [0x200b, "sıfır genişlikli boşluk"],
  [0x200c, "sıfır genişlikli ayırıcı olmayan"],
  [0x200d, "sıfır genişlikli birleştirici"],
  [0x200e, "soldan sağa işareti"],
  [0x200f, "sağdan sola işareti"],
  [0xfeff, "BOM / sıfır genişlikli kırılmaz boşluk"],
]);

const ROOT = path.join(__dirname, "..");
const ATLA = new Set(["node_modules", ".git"]);

function kaynakDosyalari(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ATLA.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) kaynakDosyalari(p, out);
    else if (/\.(js|json|md)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("collector kaynağında görünmez kontrol karakteri yok", () => {
  const bulgular = [];
  for (const p of kaynakDosyalari()) {
    const s = fs.readFileSync(p, "utf8");
    for (let i = 0; i < s.length; i++) {
      const ad = YASAK.get(s.codePointAt(i));
      if (!ad) continue;
      const satir = s.slice(0, i).split("\n").length;
      bulgular.push(`${path.relative(ROOT, p)}:${satir} → ${ad}`);
    }
  }
  assert.deepStrictEqual(bulgular, [], `görünmez karakter:\n${bulgular.join("\n")}`);
});

test("tarama gerçekten çalışıyor (test kendini kandırmıyor)", () => {
  const dosyalar = kaynakDosyalari();
  assert.ok(dosyalar.length > 15, `beklenenden az dosya tarandı: ${dosyalar.length}`);
  assert.ok(dosyalar.some((p) => p.endsWith(path.join("lib", "sender.js"))));
  assert.ok(dosyalar.some((p) => p.endsWith(path.join("hooks", "heartbeat.js"))));
});
