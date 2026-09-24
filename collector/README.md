# UsagEX collector

Codex desteği `codex/` altındadır ve Claude kurulumundan ayrıdır. Mobil uygulamada
Codex → Ayarlar → Bilgisayar bağla ile alınan kodu kullanın:

```sh
node collector/codex/connect.js ABCD2345
```

`connect.js` kodu harcar, Mac'te LaunchAgent'ı, Linux'ta `systemctl --user`
varsa `usagex-codex.service` + `.timer` birimlerini kurar ve ilk taramayı arka
planda başlatır (`~/.usagex/codex-collect.log`). systemd yoksa
`node collector/codex/collect.js --watch` açık tutulur. Kaldırmak için
`node collector/codex/disconnect.js`. Mesajlar `USAGEX_LANG` (tr|en) ile, Node yolu
`USAGEX_NODE` ile seçilir. Bu servis mevcut Codex `notify` ayarına dokunmaz. İsteyen kullanıcı
`notify` komutuna `collect.js` ekleyebilir; script bu komutun JSON argümanını okumaz.
Yalnız `$CODEX_HOME/sessions` (varsayılan `~/.codex/sessions`) kullanım sayaçları
işlenir. Ayrı config/kuyruk: `$CODEX_HOME/usagex`. Varsayılan ad gizleme açıktır.
Sunucu adresi `USAGEX_SERVER_URL` ile değiştirilebilir (HTTPS veya loopback).
Detaylar: [Codex bağlantısı](../docs/codex-computer-bridge.md).

## Claude kurulumu

Claude Code eklentisi (plugin). Claude aboneliğinin limit yüzdelerini ve oturum
token/maliyet özetini UsagEX backend'ine gönderir. **OAuth token'ı makineden
çıkmaz** — Anthropic çağrıları bu bilgisayardan yapılır, sunucuya yalnız sayılar
(yüzdeler, token adetleri, tahmini maliyet) gider.

## Kurulum

```
/plugin marketplace add dijitalpi/usagex-collector
/plugin install usagex
/usagex-connect <8-karakterli-kod>     # kod: UsagEX app → Ayarlar → Bilgisayar bağla
```

Node 18+ gerekir (global `fetch`). Bağlantı kurulunca son 90 gün arka planda
backfill edilir (`~/.usagex/backfill.log`). Kurulum betiğinden gelen
`USAGEX_LANG` (tr|en) mesaj dilini, `USAGEX_NODE` hook ve servislerin
kullanacağı Node yolunu belirler. Bağlantıyı kesmek için `/usagex-disconnect`, yalnız duraklatmak
için `~/.claude/usagex.json` içinde `"enabled": false`.

## Ne zaman ne gönderilir

| Hook | Gönderilen | Throttle |
|---|---|---|
| SessionStart / Stop | limit yüzdesi snapshot'ı | küresel **2 dk** |
| SessionStart / Stop | oturum özeti (token/model/gün dökümü) | oturum başına **5 dk** |
| SessionEnd | oturum özeti + taze yüzde | throttle yok |

Limit yüzdesi ayrıca `~/.claude/usagex-usage-cache.json` içinde önbelleklenir
(varsayılan 5 dk; oturum aktifken 2 dk). Uç 429 verirse `retry-after` süresince
hiç sorulmaz, son bilinen değer `stale` işaretiyle taşınır.

## Sürüm 0.3.0'a geçenler: maliyetleri yeniden fiyatlandırın

0.3.0 fiyat tablosunu resmî tarifelerle hizaladı (**fiyat kuşağı 3**:
Opus katmanı 5/25, Fable/Mythos 10/50, Sonnet 5 kalıcı 2/10, cache yazımında
5 dk / 1 saat ayrımı). Daha önce gönderilmiş kayıtlar ESKİ tarifeyle
hesaplanmıştı — bazı modellerde maliyet 2-3 kat şişik görünüyor.

**0.3.0'a geçtikten sonra `node scripts/backfill.js 90` çalıştırın; geçmiş
maliyetler yeni tarifeyle yeniden fiyatlanır.** Backfill `session_id` ile upsert
yaptığı için tekrar çalıştırmak güvenlidir, satır çoğalmaz. Elde ne varsa o
gönderilir: Claude Code eski transkriptleri ~30 günde temizler.

Backfill **kuyruğa yazmaz**: sunucunun hız sınırına (600/dk) takılınca bekler ve
aynı kaydı yeniden dener; ilerleme 50 kayıtta bir stderr'e yazılır (`312/4428`).
Ctrl-C güvenlidir — aynı komut kaldığı yerden devam eder. Erken durursa sebebi
tek satırla söyler (hız sınırı / günlük satır kotası / ağ). Daha eski bir
sürümün kuyrukta biriktirdiği kayıtlar varsa önce onları boşaltmak için:

```bash
node scripts/backfill.js 90 --drain
```

Her oturum satırı hangi tarifeyle hesaplandığını `pricing_version` alanında
taşır (`lib/pricing.js` → `PRICING_VERSION`); tablo ya da hesap yöntemi her
değiştiğinde bu sayı artırılır.

## Geliştirme

```bash
node --test          # collector/ içinde
```

`.claude-plugin/plugin.json` ve `package.json` sürümleri AYNI olmalı. Kaynak
private repodaki `collector/` dizinidir; public repo türetilmiş kopyadır, orada
elle düzenleme yapılmaz.
