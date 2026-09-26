// Kullanıcıya görünen collector metinleri. Dil USAGEX_LANG ile seçilir
// (kurulum betiği uygulamanın dilini geçirir); tanınmayan/boş değer → tr.
// Şablon: "{ad}" yer tutucuları msg(key, { ad }) ile doldurulur.

const MESSAGES = {
  tr: {
    usage_claude: "Kullanım: connect.js <8 karakterli kod>. Kodu UsagEX uygulamasında Ayarlar → Bilgisayarlar bölümünden alın.",
    usage_codex: "Kullanım: codex/connect.js <8 karakterli kod>. Kodu UsagEX uygulamasında Codex → Ayarlar → Bilgisayarlar bölümünden alın.",
    node_too_old: "Node.js {version} çok eski. UsagEX için Node.js {min} veya üstü gerekir. Güncelleyip tekrar deneyin: https://nodejs.org",
    unexpected: "Beklenmeyen bir hata oluştu: {reason}",

    settings_invalid: "{file} geçerli JSON değil. Hiçbir şey değiştirilmedi. Dosyayı düzeltip tekrar çalıştırın (yorum satırı ve fazladan virgül JSON'da geçersizdir).",
    settings_not_object: "{file} bir JSON nesnesi değil. Hiçbir şey değiştirilmedi.",
    settings_unreadable: "{file} okunamadı ({reason}). Hiçbir şey değiştirilmedi. Dosya izinlerini kontrol edin.",
    settings_write_failed: "{file} yazılamadı: {reason}",
    backup_failed: "Ayar dosyasının yedeği alınamadı ({reason}). Yedeksiz yazılmadı.",
    dir_not_writable: "{dir} klasörüne yazılamıyor. Hiçbir şey değiştirilmedi. Klasörün izinlerini kontrol edin.",
    code_unused: "Kodunuz kullanılmadı. Sorunu giderdikten sonra aynı komutu tekrar çalıştırabilirsiniz.",
    claude_missing: "Claude Code bu bilgisayarda henüz yok. Claude Code'u kurduğunuzda veri otomatik akar.",
    codex_missing: "Codex bu bilgisayarda henüz yok. Codex'i kurduğunuzda veri otomatik akar.",

    network_error: "Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edip komutu tekrar çalıştırın.",
    code_format: "Kod 8 karakter olmalı (harf ve rakam). Kodu uygulamada göründüğü gibi yazın.",
    code_invalid: "Bu kod çalışmadı: yanlış yazılmış, süresi dolmuş ya da kullanılmış olabilir. UsagEX uygulamasından yeni kod alın.",
    rate_limited: "Çok fazla deneme yapıldı. Bir dakika bekleyip tekrar deneyin.",
    server_busy: "Sunucu şu an yanıt vermiyor ({status}). Birkaç dakika sonra tekrar deneyin.",
    server_error: "Bağlantı kurulamadı (sunucu yanıtı {status}). Uygulamadan yeni kod alıp tekrar deneyin.",
    bad_response: "Sunucudan beklenmeyen bir yanıt geldi. Bağlantı kurulmadı, tekrar deneyin.",
    wrong_provider: "Bu kod Codex için değil. Uygulamada Codex → Ayarlar → Bilgisayarlar bölümünden yeni kod alın.",
    redirect_refused: "Sunucu yanıtı başka bir adrese yönlendiriyor. Güvenlik için bağlantı kurulmadı.",
    server_url_invalid: "Sunucu adresi geçersiz (USAGEX_SERVER_URL). HTTPS bir adres kullanın.",
    save_failed: "Bağlantı bilgisi kaydedilemedi ({reason}).",
    hooks_failed: "Claude Code ayarlarına yazılamadı ({reason}). Uygulamadan yeni kod alıp komutu tekrar çalıştırın.",
    privacy_kept: "Proje ve bilgisayar adlarını gizleme ayarınız korundu.",

    connected: "✓ Bilgisayarınız bağlandı. Bu pencereyi kapatabilirsiniz. Geçmiş kullanımınız birkaç dakika içinde telefonda görünür.",
    history_not_started: "Geçmiş kullanım gönderimi başlatılamadı. Yeni oturumlarınız yine gelir. Geçmişi göndermek için: {cmd}",
    // Hook'lar Claude Code açılırken okunur: kurulumdan önce açılmış pencereler veri göndermez.
    restart_claude: "Açık Claude Code pencerelerini kapatıp yeniden açın.",
    disconnect_hint: "Bağlantıyı kesmek isterseniz: {cmd}",
    uninstall_hint: "UsagEX'i bu bilgisayardan kaldırmak isterseniz: {cmd}",

    codex_connected: "✓ Codex bağlandı. Bu pencereyi kapatabilirsiniz. Geçmiş kullanımınız birkaç dakika içinde telefonda görünür.",
    codex_privacy: "Yalnız kullanım sayaçları ve limitler gönderilir. Proje ve bilgisayar adları gizlenir.",
    codex_service_failed: "Otomatik güncelleme başlatılamadı. Güncel veri için şu komutu açık tutun: {cmd}",
    codex_manual: "Bu sistemde otomatik güncelleme kurulamadı. Güncel veri için şu komutu açık tutun: {cmd}",
    codex_scan_busy: "Codex taraması şu an çalışıyor. Birkaç saniye sonra tekrar deneyin.",
    codex_disconnected: "Codex bağlantısı kesildi. Bu bilgisayardan artık Codex verisi gönderilmeyecek.",
    service_removed: "✓ Otomatik güncelleme durduruldu.",
    service_installed: "✓ Otomatik güncelleme açıldı.",

    hooks_installed: "✓ Claude Code hook'ları kuruldu ({file})",
    hooks_backup: "ℹ Önceki ayarların yedeği: {file}",
    retention_set: "✓ Transkript saklama 10 yıla çıkarıldı (cleanupPeriodDays=3650).",
    retention_hint: "ℹ Claude Code eski transkriptleri yaklaşık 30 günde siler. Saklamayı 10 yıla çıkarmak için: node install-hooks.js <dizin> --keep-transcripts",
    dir_signature_warning: "⚠ Kurulum dizininde 'usagex' geçmiyor ({dir}). Sonraki kurulum eski girişi tanıyamayabilir; dizini 'usagex' içeren bir yola taşıyın.",

    revoke_ok: "✓ Sunucudaki cihaz kaydı silindi.",
    revoke_gone: "· Bu bilgisayarın sunucuda kaydı zaten yoktu.",
    revoke_failed: "✗ Sunucudaki kayıt silinemedi ({reason}).",
    revoke_manual: "Uygulamada Ayarlar → Bilgisayarlar bölümünden bu bilgisayarı silin.",
    config_disabled: "✓ Bu bilgisayardaki bağlantı bilgisi silindi.",
    config_write_failed: "✗ {file} yazılamadı: {reason}",
    not_connected: "· Bu bilgisayar bağlanmamış görünüyor.",
    local_data_removed: "✓ Gönderilmeyi bekleyen yerel veriler silindi.",
    hooks_removed: "✓ UsagEX, Claude Code ayarlarından kaldırıldı.",
    disconnected: "Bağlantı kesildi. Bu bilgisayardan artık veri gönderilmeyecek.",
    history_kept: "Geçmiş kullanımınız hesabınızda kalır. Tamamen silmek için uygulamada Ayarlar → Hesap → UsagEX hesabını sil.",
    reconnect: "Tekrar bağlamak için uygulamadan yeni kod alın.",
  },
  en: {
    usage_claude: "Usage: connect.js <8-character code>. Get the code in the UsagEX app under Settings → Computers.",
    usage_codex: "Usage: codex/connect.js <8-character code>. Get the code in the UsagEX app under Codex → Settings → Computers.",
    node_too_old: "Node.js {version} is too old. UsagEX needs Node.js {min} or newer. Update it and try again: https://nodejs.org",
    unexpected: "Something went wrong: {reason}",

    settings_invalid: "{file} is not valid JSON. Nothing was changed. Fix the file and run the command again (comments and trailing commas are not valid JSON).",
    settings_not_object: "{file} is not a JSON object. Nothing was changed.",
    settings_unreadable: "Could not read {file} ({reason}). Nothing was changed. Check the file permissions.",
    settings_write_failed: "Could not write {file}: {reason}",
    backup_failed: "Could not back up the settings file ({reason}). Nothing was written without a backup.",
    dir_not_writable: "Cannot write to {dir}. Nothing was changed. Check the folder permissions.",
    code_unused: "Your code was not used. Fix the problem and run the same command again.",
    claude_missing: "Claude Code is not installed on this computer yet. Data will start flowing once you install it.",
    codex_missing: "Codex is not installed on this computer yet. Data will start flowing once you install it.",

    network_error: "Could not reach the server. Check your internet connection and run the command again.",
    code_format: "The code has 8 characters (letters and digits). Type it exactly as the app shows it.",
    code_invalid: "This code didn't work. It may be mistyped, expired or already used. Get a new code in the UsagEX app.",
    rate_limited: "Too many attempts. Wait a minute and try again.",
    server_busy: "The server is not responding right now ({status}). Try again in a few minutes.",
    server_error: "Could not connect (server response {status}). Get a new code in the app and try again.",
    bad_response: "The server sent an unexpected response. Nothing was connected. Please try again.",
    wrong_provider: "This code is not for Codex. Get a new code in the app under Codex → Settings → Computers.",
    redirect_refused: "The server response points to a different address. The connection was refused for safety.",
    server_url_invalid: "The server address (USAGEX_SERVER_URL) is not valid. Use an HTTPS address.",
    save_failed: "Could not save the connection ({reason}).",
    hooks_failed: "Could not write the Claude Code settings ({reason}). Get a new code in the app and run the command again.",
    privacy_kept: "Your setting to hide project and computer names was kept.",

    connected: "✓ Your computer is connected. You can close this window. Your past usage will appear on your phone within a few minutes.",
    history_not_started: "Could not start sending your past usage. New sessions will still arrive. To send the history, run: {cmd}",
    restart_claude: "Close and reopen any open Claude Code windows.",
    disconnect_hint: "To disconnect later, run: {cmd}",
    uninstall_hint: "To remove UsagEX from this computer later, run: {cmd}",

    codex_connected: "✓ Codex is connected. You can close this window. Your past usage will appear on your phone within a few minutes.",
    codex_privacy: "Only usage counters and limits are sent. Project and computer names stay hidden.",
    codex_service_failed: "Automatic updates could not start. For fresh data, keep this command running: {cmd}",
    codex_manual: "Automatic updates are not available on this system. For fresh data, keep this command running: {cmd}",
    codex_scan_busy: "A Codex scan is running. Try again in a few seconds.",
    codex_disconnected: "Codex is disconnected. This computer will no longer send Codex data.",
    service_removed: "✓ Automatic updates stopped.",
    service_installed: "✓ Automatic updates are on.",

    hooks_installed: "✓ Claude Code hooks installed ({file})",
    hooks_backup: "ℹ Backup of your previous settings: {file}",
    retention_set: "✓ Transcript retention raised to 10 years (cleanupPeriodDays=3650).",
    retention_hint: "ℹ Claude Code deletes transcripts after about 30 days. To keep them for 10 years, run: node install-hooks.js <dir> --keep-transcripts",
    dir_signature_warning: "⚠ The install folder does not contain 'usagex' ({dir}). A later install may not recognize the old entry; move it to a path that contains 'usagex'.",

    revoke_ok: "✓ The device record on the server was deleted.",
    revoke_gone: "· The server had no record of this computer.",
    revoke_failed: "✗ Could not delete the record on the server ({reason}).",
    revoke_manual: "Remove this computer in the app under Settings → Computers.",
    config_disabled: "✓ The connection details on this computer were deleted.",
    config_write_failed: "✗ Could not write {file}: {reason}",
    not_connected: "· This computer does not look connected.",
    local_data_removed: "✓ Local data waiting to be sent was deleted.",
    hooks_removed: "✓ UsagEX was removed from the Claude Code settings.",
    disconnected: "Disconnected. This computer will no longer send data.",
    history_kept: "Your past usage stays in your account. To delete everything, go to Settings → Account → Delete UsagEX account in the app.",
    reconnect: "To connect again, get a new code in the app.",
  },
};

function lang(env = process.env) {
  const l = String((env && env.USAGEX_LANG) || "").trim().toLowerCase();
  return l === "en" || l.startsWith("en-") || l.startsWith("en_") ? "en" : "tr";
}

function msg(key, vars = {}, l = lang()) {
  const table = MESSAGES[l] || MESSAGES.tr;
  const template = table[key] ?? MESSAGES.tr[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (m, name) => (vars[name] === undefined ? m : String(vars[name])));
}

// Kodun anlamlı bir mesaj anahtarı taşıyan hatası: CLI yalnız msg() basar.
class UserError extends Error {
  constructor(key, vars = {}) {
    super(msg(key, vars));
    this.key = key;
    this.vars = vars;
  }
}

module.exports = { MESSAGES, lang, msg, UserError };
