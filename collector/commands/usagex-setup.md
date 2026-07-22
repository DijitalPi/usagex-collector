---
description: UsagEX collector ilk kurulum — cihazı UsagEX backend'ine bağlar
---

UsagEX collector kurulumunu yap. Adımlar:

1. `~/.claude/usagex.json` dosyası var mı bak. Varsa mevcut ayarları göster
   (device_token'ı maskele) ve kullanıcıya güncellemek isteyip istemediğini sor.
2. **Asıl yol — eşleştirme kodu:** Kullanıcıya UsagEX uygulamasında
   **Ayarlar > Bilgisayar bağla > Eşleştirme kodu üret** adımını izletip
   8 karakterli kodu iste, sonra şunu çalıştır:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.js" <kod>`
   Bu komut cihaz token'ını alır, `usagex.json`'ı yazar ve son 30 günün
   oturumlarını otomatik backfill eder. Başarılıysa 5. adıma atla.
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
   (`send_project_names`) — varsayılan açık; hayır derse klasör adları hash'lenir.
5. Bağlantıyı test et: `node "${CLAUDE_PLUGIN_ROOT}/scripts/ping.js"` çalıştır.
   `OK` basarsa kurulum tamam; hata basarsa kodu/URL'yi tekrar kontrol ettir.
6. Kullanıcıya özetle: bundan sonra her Claude Code oturumu başında/sırasında
   (5 dk aralıkla) limit yüzdeleri, oturum sonunda da token özeti gönderilecek;
   OAuth token'ı makineden asla çıkmayacak; kapatmak için `usagex.json` içinde
   `"enabled": false` yapması ya da dosyayı silmesi yeterli.
