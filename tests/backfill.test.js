const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { listTranscripts } = require("../scripts/backfill");

// backfill mtime cutoff'u: N günden eski transkriptler HİÇ okunmaz (yüzlerce
// dosyayı boşuna ayrıştırmamak için). Cutoff'un yanlış tarafa kayması ya
// geçmişi eksik gönderir ya da her çalıştırmada her şeyi yeniden okur.

function tmpProjects() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usagex-bf-"));
  const projects = path.join(root, "projects");
  fs.mkdirSync(projects);
  return projects;
}

function addFile(projects, proje, name, mtimeMs) {
  const dir = path.join(projects, proje);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, "{}\n");
  if (mtimeMs != null) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

const GUN = 24 * 60 * 60 * 1000;

test("cutoff'tan YENİ dosyalar seçilir, eskiler atlanır", () => {
  const projects = tmpProjects();
  const now = Date.now();
  const cutoff = now - 90 * GUN;

  const yeni = addFile(projects, "p1", "yeni.jsonl", now - 1 * GUN);
  const sinirda = addFile(projects, "p1", "sinirda.jsonl", cutoff + 1000);
  addFile(projects, "p1", "eski.jsonl", now - 200 * GUN);
  addFile(projects, "p2", "cok-eski.jsonl", now - 91 * GUN);

  const { files, tooOld } = listTranscripts(projects, cutoff);

  assert.deepStrictEqual(files.sort(), [sinirda, yeni].sort());
  assert.strictEqual(tooOld, 2);
});

test("yalnız .jsonl toplanır; başka uzantılar ve alt klasörler görmezden gelinir", () => {
  const projects = tmpProjects();
  const now = Date.now();
  const jsonl = addFile(projects, "p1", "a.jsonl", now);
  addFile(projects, "p1", "notlar.md", now);
  addFile(projects, "p1", "a.jsonl.bak", now);
  fs.mkdirSync(path.join(projects, "p1", "a", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(projects, "p1", "a", "subagents", "s.jsonl"), "{}\n");

  const { files } = listTranscripts(projects, 0);

  // alt-ajan dosyaları AYRI gönderilmez — summarizeTranscript ana oturuma katar
  assert.deepStrictEqual(files, [jsonl]);
});

test("projects/ altındaki dosyalar (dizin olmayan) çökertmez", () => {
  const projects = tmpProjects();
  fs.writeFileSync(path.join(projects, "gevsek-dosya.txt"), "x");
  const p = addFile(projects, "p1", "a.jsonl", Date.now());
  assert.deepStrictEqual(listTranscripts(projects, 0).files, [p]);
});

test("projects klasörü yoksa boş sonuç, throw YOK", () => {
  const { files, tooOld } = listTranscripts(path.join(os.tmpdir(), "hic-olmayan-dizin-usagex"), 0);
  assert.deepStrictEqual(files, []);
  assert.strictEqual(tooOld, 0);
});

test("cutoff=0 ile her şey seçilir (sınırsız backfill)", () => {
  const projects = tmpProjects();
  addFile(projects, "p1", "a.jsonl", Date.now() - 3650 * GUN);
  addFile(projects, "p2", "b.jsonl", Date.now());
  assert.strictEqual(listTranscripts(projects, 0).files.length, 2);
});
