const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { shouldHeartbeat, statePath, HEARTBEAT_MIN_INTERVAL_MS } = require("../lib/state");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clmt-test-"));
}

test("ilk çağrıda true döner ve zamanı yazar", () => {
  const dir = tmpDir();
  let t = 1_000_000;
  assert.strictEqual(shouldHeartbeat({ dir, now: () => t }), true);
  const state = JSON.parse(fs.readFileSync(statePath(dir), "utf8"));
  assert.strictEqual(state.last_heartbeat_at, t);
});

test("throttle penceresi içinde false döner", () => {
  const dir = tmpDir();
  let t = 1_000_000;
  assert.strictEqual(shouldHeartbeat({ dir, now: () => t }), true);
  t += HEARTBEAT_MIN_INTERVAL_MS - 60 * 1000; // pencerenin 1 dk içi
  assert.strictEqual(shouldHeartbeat({ dir, now: () => t }), false);
});

test("pencere dolunca tekrar true döner", () => {
  const dir = tmpDir();
  let t = 1_000_000;
  assert.strictEqual(shouldHeartbeat({ dir, now: () => t }), true);
  t += HEARTBEAT_MIN_INTERVAL_MS + 60 * 1000;
  assert.strictEqual(shouldHeartbeat({ dir, now: () => t }), true);
});

test("bozuk state dosyası sıfırdan başlatır", () => {
  const dir = tmpDir();
  fs.writeFileSync(statePath(dir), "not-json{{{");
  assert.strictEqual(shouldHeartbeat({ dir, now: () => 5 }), true);
});
