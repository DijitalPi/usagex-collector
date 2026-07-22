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
3. Çıktı `✔ Cihaz bağlandı` diyorsa tamam. `ping.js` ile doğrula.
   Kod geçersiz/süresi dolmuşsa kullanıcıdan uygulamadan yeni kod almasını iste.
4. Kullanıcıya özetle: OAuth token'ı bu makineden asla çıkmayacak; sunucuya yalnızca
   limit yüzdeleri ve token/model istatistikleri gidecek; kapatmak için
   `~/.claude/usagex.json` içinde `"enabled": false` yapması yeterli.
