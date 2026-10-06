// Windows Görev Zamanlayıcı başlatıcısı ortamı argümanla verir: --env=AD=değer
// (lib/win-task.js; JScript'ten ortama atama yeni betik motorunda güvenilmez).
// Yalnız bilinen adlar kabul edilir; betiğin en başında, diğer modüller
// ortamı okumadan önce çağrılır.
//
// NOT (modül biçimi): CommonJS — betikler ve testler doğrudan require eder.
const NAMES = new Set(["CODEX_HOME", "CLAUDE_CONFIG_DIR"]);

function applyEnvArgs(argv = process.argv.slice(2), env = process.env) {
  for (const arg of argv) {
    const m = /^--env=([A-Z_]+)=(.+)$/s.exec(String(arg));
    if (m && NAMES.has(m[1])) env[m[1]] = m[2];
  }
  return env;
}

module.exports = { applyEnvArgs, NAMES };
