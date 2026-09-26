---
description: UsagEX collector ilk kurulum — cihazı UsagEX backend'ine bağlar
---

UsagEX collector kurulumunu yap. Adımlar:

0. **Ön koşul — Node 18+:** `node -v` çalıştır. 18'den küçükse kurulumu YAPMA;
   kullanıcıya Node'u güncellemesini söyle. (Collector global `fetch` kullanıyor;
   16'da hook'lar sessizce hiç veri göndermez — kullanıcı bunu fark edemez.)
   `connect.js` ve `install-hooks.js` bu kontrolü kendileri de yapar ve durur.
1. `~/.claude/usagex.json` dosyası var mı bak. Varsa mevcut ayarları göster
   (device_token'ı maskele) ve kullanıcıya güncellemek isteyip istemediğini sor.
2. **Asıl yol — eşleştirme kodu:** Kullanıcıya UsagEX uygulamasında
   **Ayarlar → Bilgisayarlar → Bağlantı kodu oluştur** adımını izletip
   8 karakterli kodu iste, sonra şunu çalıştır:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.js" <kod>`
   Bu komut önce `settings.json`'ı kontrol eder (bozuksa kodu harcamadan durur),
   cihaz token'ını alır, `usagex.json`'ı yazar ve son **90 günün** oturumlarını
   arka planda backfill eder (`~/.usagex/backfill.log`). (Claude Code eski transkriptleri ~30 günde
   temizler; 90 istemek zarar vermez, ne varsa onu gönderir.) Başarılıysa 5. adıma atla.
   Mevcut bir `usagex.json` varsa `send_project_names` tercihi KORUNUR — yeniden
   bağlanmak gizlilik ayarını sıfırlamaz.
3. **Yedek yol (yalnızca operasyon/elle kurulum):** Kod akışı kullanılamıyorsa
   kullanıcıdan Ingest URL (örn. `https://usagex.dijitalpi.com/ingest` — https şart)
   ve sunucudaki `devices` tablosundan alınmış bir `token` iste. (Uygulamada
   token gösteren bir ekran YOKTUR; token ancak sunucu yöneticisinden alınır.)
4. Yedek yolda dosyayı şu formatta, 0600 izinle yaz:

```json
{
  "enabled": true,
  "ingest_url": "<url>",
  "device_token": "<token>",
  "send_project_names": true
}
```

   Kullanıcıya proje adlarının açık gönderilip gönderilmeyeceğini sor
   (`send_project_names`) — varsayılan açık; hayır derse klasör adları hash'lenir
   (`p-<8 hex>`). Bu tercih **bilgisayar adını da** kapsar: kapalıyken hostname
   yerine `pc-<6 hex>` gönderilir (makine adları çoğu kurulumda kişi adı içerir).
5. Bağlantıyı test et: `node "${CLAUDE_PLUGIN_ROOT}/scripts/ping.js"` çalıştır.
   `OK` basarsa kurulum tamam. Hata basarsa mesaj sebebi söyler (config yok /
   `enabled:false` / `device_token` eksik / `ingest_url` https değil) — ona göre
   düzelt. Çıktıdaki **"Token kaynağı"** satırı limit yüzdelerinin nereden
   okunduğunu gösterir: `dosya` (~/.claude/.credentials.json), `keychain` (macOS)
   `yok` ya da `süresi dolmuş` — `yok` ise kullanıcı Claude Code'da giriş
   yapmamış, `süresi dolmuş` ise token'ın ömrü bitmiş demektir (çözüm:
   `claude /login`). İki durumda da oturum/token istatistikleri yine gider,
   yalnız limit yüzdeleri gelmez.
   Ping `bağlantı sunucuda iptal edilmiş` diyorsa cihaz uygulamadan silinmiştir:
   `/usagex-connect <kod>` ile yeniden bağlan.
6. **Transkript saklama (opsiyonel, standalone kurulum):** Claude Code eski
   oturumları ~30 günde siler; UsagEX raporu bundan eskisini gösteremez. Uzatmak
   isteyen kullanıcı için `install-hooks.js`'e `--keep-transcripts` bayrağı verilir
   (`cleanupPeriodDays=3650` yazar). **Varsayılan DOKUNMAMAKTIR** — kullanıcıya
   sormadan tüm konuşma geçmişini 10 yıl saklatma. Kullanıcının kendi koyduğu
   değer hiçbir durumda ezilmez.
7. **Node yolu:** standalone hook komutu `sh "<dizin>/scripts/run-hook.sh" heartbeat.js`
   biçimindedir (Windows'ta `cmd /c "…"` sarmalıyla doğrudan node). run-hook.sh
   Node'u her çalışmada `USAGEX_NODE`, `~/.usagex/node-path`, PATH ve bilinen
   yerlerden bulur; Homebrew/nvm ile Node güncellenince hook'lar durmaz.
   `node-path` kurulumda `USAGEX_NODE`'dan (yoksa çalışan node'dan) yazılır.
8. **Sürüm yükseltmesinde (0.3.0) maliyetleri yeniden fiyatlandır:** Eklenti
   0.3.0'dan ÖNCEKİ bir sürümden güncellendiyse geçmiş kayıtlar eski fiyat
   tablosuyla hesaplanmıştır (bazı modellerde maliyet 2-3 kat şişik).
   **0.3.0'a geçtikten sonra `node "${CLAUDE_PLUGIN_ROOT}/scripts/backfill.js" 90`
   çalıştırın, geçmiş maliyetler yeni tarifeyle yeniden fiyatlanır.** Backfill
   `session_id` ile upsert yapar — tekrar çalıştırmak güvenlidir, satır çoğalmaz.
   (Yeni kurulumda gerekmez: `/usagex-connect` zaten 90 günü backfill eder.)
   Backfill kuyruğa YAZMAZ: sunucu hız sınırında (600/dk) bekleyip yeniden dener,
   ilerlemeyi 50 kayıtta bir stderr'e yazar, Ctrl-C güvenlidir (aynı komut
   kaldığı yerden devam eder). Erken durursa sebebini tek satırla söyler.
   Eski bir sürümün kuyrukta biriktirdiği kayıtlar varsa önce onları göndermek
   için `--drain` ekle: `… backfill.js 90 --drain`.
9. Kullanıcıya özetle: bundan sonra her Claude Code oturumu başında/sırasında
   limit yüzdeleri (küresel 2 dk throttle — eşik bildirimleri geç kalmasın),
   oturum özeti ise oturum başına 5 dk aralıkla ve oturum sonunda gönderilecek;
   OAuth token'ı makineden asla çıkmayacak; tamamen kapatmak için
   `/usagex-disconnect` (sunucudaki cihaz
   kaydını siler, hook'ları ve yerel artık dosyaları temizler), yalnız geçici
   duraklatmak için `usagex.json` içinde `"enabled": false`.
