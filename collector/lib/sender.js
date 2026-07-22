const fs = require("fs");
const path = require("path");
const { claudeDir } = require("./config");

const TIMEOUT_MS = 3000;
const MAX_FLUSH = 50; // tek hook çalışmasında en fazla bu kadar kuyruk elemanı denenir

function defaultQueuePath() {
  return path.join(claudeDir(), "usagex-queue.jsonl");
}

async function post(payload, config, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(config.ingest_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.device_token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Kuyruktaki bekleyenleri sırayla dener; ilk başarısızlıkta durur (sıra korunur).
async function flushQueue(config, { fetchImpl = fetch, queuePath } = {}) {
  try {
    if (!queuePath) queuePath = defaultQueuePath();
  } catch {
    return;
  }
  let lines;
  try {
    lines = fs.readFileSync(queuePath, "utf8").split("\n").filter(Boolean);
  } catch {
    return; // kuyruk yok
  }
  const remaining = [...lines];
  for (const line of lines.slice(0, MAX_FLUSH)) {
    let payload;
    try { payload = JSON.parse(line); } catch { remaining.shift(); continue; }
    if (!(await post(payload, config, fetchImpl))) break;
    remaining.shift();
  }
  try {
    if (remaining.length === 0) fs.unlinkSync(queuePath);
    else fs.writeFileSync(queuePath, remaining.join("\n") + "\n", { mode: 0o600 });
  } catch {}
}

const MAX_QUEUE_SIZE = 500; // Çevrimdışı kuyrukta saklanacak maksimum eleman sayısı

// true: gönderildi (ve kuyruk boşaltma denendi); false: kuyruğa yazıldı. Asla throw etmez.
async function sendPayload(payload, config, { fetchImpl = fetch, queuePath } = {}) {
  try {
    if (!queuePath) queuePath = defaultQueuePath();
  } catch {
    return false;
  }
  if (await post(payload, config, fetchImpl)) {
    await flushQueue(config, { fetchImpl, queuePath });
    return true;
  }
  try {
    let lines = [];
    try {
      lines = fs.readFileSync(queuePath, "utf8").split("\n").filter(Boolean);
    } catch {}
    lines.push(JSON.stringify(payload));
    if (lines.length > MAX_QUEUE_SIZE) {
      lines = lines.slice(lines.length - MAX_QUEUE_SIZE);
    }
    // 0600 — kuyruk hostname/proje/oturum/token sayımları içerir, diğer yerel
    // kullanıcılar okumasın.
    fs.writeFileSync(queuePath, lines.join("\n") + "\n", { mode: 0o600 });
  } catch {}
  return false;
}

module.exports = { sendPayload, flushQueue, defaultQueuePath, MAX_QUEUE_SIZE };
