require("./win-fs"); // Windows: dosya kilidinde rename yeniden dener
const fs = require("node:fs");
const crypto = require("node:crypto");

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}

// Ownership, not data-file mtime, determines whether a writer may be recovered.
function acquire(lock, waitMs = 0) {
  const deadline = Date.now() + waitMs;
  const nonce = crypto.randomBytes(12).toString("hex");
  for (;;) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(`${lock}/owner`, JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
      return () => {
        try {
          const owner = JSON.parse(fs.readFileSync(`${lock}/owner`, "utf8"));
          if (owner.nonce === nonce) fs.rmSync(lock, { recursive: true });
        } catch {}
      };
    } catch (e) {
      if (e.code !== "EEXIST") return null;
      try {
        let owner;
        try { owner = JSON.parse(fs.readFileSync(`${lock}/owner`, "utf8")); } catch {}
        // Allow a process time to write its owner after mkdir.
        if (owner ? !alive(owner.pid) : Date.now() - fs.statSync(lock).mtimeMs > 5000) {
          const stat = fs.statSync(lock);
          const gate = `${lock}.reap-${owner?.nonce || stat.ino}`;
          let gateFd;
          try { gateFd = fs.openSync(gate, "wx", 0o600); } catch { return null; }
          try {
            // A second reaper must never rename the next owner's live lock.
            if (fs.statSync(lock).ino !== stat.ino) continue;
            const tomb = `${lock}.dead-${process.pid}-${nonce}`;
            fs.renameSync(lock, tomb);
            fs.rmSync(tomb, { recursive: true });
          } finally {
            fs.closeSync(gateFd);
            try { fs.unlinkSync(gate); } catch {}
          }
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function withLock(lock, fn) {
  const release = acquire(lock, 1000);
  if (!release) throw new Error("Local state is busy");
  try { return fn(); } finally { release(); }
}
module.exports = { acquire, withLock, alive };
