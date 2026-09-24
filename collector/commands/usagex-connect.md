---
description: UsagEX — bu bilgisayarı telefonundaki hesaba bağla (8 karakterli kod)
argument-hint: <8-karakterli-kod>
---

Kullanıcı bu bilgisayarı (Mac/Linux/Windows) UsagEX hesabına bağlamak istiyor.

Adımlar:
1. Argüman olarak 8 karakterli bir kod verilmişse (`$ARGUMENTS`), doğrudan onu kullan.
   Verilmemişse kullanıcıya sor: "UsagEX uygulamasında Ayarlar > Bilgisayar bağla'dan
   8 karakterli kodu al ve buraya yaz."
2. Şu komutu çalıştır (kodu yerine koy):
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.js" <kod>`
3. Çıktı `✓ Bilgisayarınız bağlandı` diyorsa tamam. Doğrula:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/ping.js"`
   Kod geçersiz/süresi dolmuşsa kullanıcıdan uygulamadan yeni kod almasını iste.
   `settings.json geçerli JSON değil` diyorsa kod harcanmamıştır: dosya düzeltilip
   aynı kodla tekrar çalıştırılabilir.
4. Bağlantı kurulduğunda son **90 günün** oturumları arka planda gönderilir
   (ilerleme `~/.usagex/backfill.log`). Claude Code eski transkriptleri ~30 günde
   temizlediği için pratikte elde ne varsa o gider; kullanıcıya "90 gün geriye
   gider" diye söz VERME.
5. Kullanıcıya özetle: OAuth token'ı bu makineden asla çıkmayacak; sunucuya yalnızca
   limit yüzdeleri ve token/model istatistikleri gidecek; geçici durdurmak için
   `~/.claude/usagex.json` içinde `"enabled": false`, tamamen ayrılmak için
   `/usagex-disconnect` (sunucudaki cihaz kaydını da siler, hook'ları ve yerel
   artık dosyaları temizler).
