const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { withLock } = require("./file-lock");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

// A resumed/forked transcript can contain the same assistant message. Assign
// each ID to one local session; only hashes are persisted, no message content.
// Claims stay stable across backfills and process restarts.
function messageOwner(dir, session) {
  const root = path.join(dir, "usagex-message-owners");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const owner = hash(session);
  const local = new Map(), shards = new Map();
  const read = file => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; return {}; }
  };
  return (id) => {
    const key = hash(id);
    if (local.has(key)) return local.get(key);
    const file = path.join(root, key.slice(0, 2) + ".json");
    // Ownership is immutable. Re-reading an existing transcript needs one
    // read per shard, not a disk lock and JSON parse per assistant message.
    if (!shards.has(file)) shards.set(file, read(file));
    const known = shards.get(file)[key];
    if (known) { const accepted = known === owner; local.set(key, accepted); return accepted; }
    const accepted = withLock(file + ".lock", () => {
      const entries = read(file);
      shards.set(file, entries);
      if (entries[key]) return entries[key] === owner;
      entries[key] = owner;
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    });
    local.set(key, accepted);
    return accepted;
  };
}
module.exports = { messageOwner };
