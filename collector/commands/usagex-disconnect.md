---
description: UsagEX — bu bilgisayarın bağlantısını kes (veri göndermeyi durdur)
---

Kullanıcı bu bilgisayarı UsagEX'ten ayırmak istiyor.

Adımlar:

1. Ne olacağını ÖNCE söyle, sonra çalıştır:
   - **sunucudaki cihaz kaydı silinir** (`POST /v1/devices/revoke`, cihaz
     token'ıyla kimliklenir; 5 sn timeout) — bu adım yerel temizlikten ÖNCE koşar,
   - `~/.claude/usagex.json` içinde `enabled: false` yapılır (dosya silinmez;
     tekrar bağlanınca token ve tercihler yerinde durur),
   - bekleyen kuyruk, throttle state, limit cache ve alt-ajan önbelleği silinir
     (rebrand öncesi `clmt-*` artıkları dahil),
   - `~/.claude/settings.json` içindeki UsagEX hook'ları kaldırılır,
   - **transkriptlere ve `cleanupPeriodDays` ayarına DOKUNULMAZ.**
2. Komut:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/disconnect.js"`
3. Çıktıyı kullanıcıya özetle:
   - `✓ Sunucudaki cihaz kaydı silindi` → sunucu tarafı da temiz, ek iş yok.
   - `· Sunucuda bu bilgisayarın kaydı zaten yoktu` (HTTP 401) → yine tamam;
     cihaz daha önce uygulamadan silinmiş demektir.
   - `✗ Sunucudaki kayıt silinemedi …` (ağ yok / timeout / 5xx / ingest_url https
     değil) → **yerel temizlik yine tamamlanmıştır**, veri gönderimi durdu; ama
     kullanıcı uygulamada **Ayarlar → Bağlı bilgisayarlar** üzerinden bu
     bilgisayarı elle silmeli. Bu uyarıyı atlama.
   - Her durumda: **geçmiş oturum istatistikleri hesapta kalır.** Tamamını silmek
     için uygulamada **Ayarlar → Hesap → Hesabı sil**.
4. Tekrar bağlanmak isterse: `/usagex-connect <8-karakterli-kod>`.

Not: yalnızca veri göndermeyi **geçici** durdurmak isteyen kullanıcı için
`~/.claude/usagex.json` içinde elle `"enabled": false` yapmak yeterlidir — bu
komut ondan farklı olarak sunucudaki cihaz kaydını da siler, hook'ları kaldırır
ve yerel artık dosyaları temizler. Geçici duraklatma isteyen birine bu komutu
önerme; yeniden bağlanmak için uygulamadan yeni bir eşleştirme kodu gerekir.
