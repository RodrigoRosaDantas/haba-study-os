import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { validateContentSnapshot } from "../site/src/content.js";

const root = resolve(".");
const fail = message => { console.error(`QUALITY FAIL · ${message}`); process.exitCode = 1; };
const ok = message => console.log(`QUALITY OK · ${message}`);

const manifest = JSON.parse(await readFile(resolve(root, "site/manifest.webmanifest"), "utf8"));
if (manifest.display !== "standalone" || manifest.lang !== "pt-BR" || !manifest.start_url) fail("manifest PWA precisa ser instalável e em pt-BR");
else ok("manifest PWA");

for (const icon of manifest.icons || []) {
  const path = resolve(root, "site", icon.src.replace(/^\.\//, ""));
  try {
    const bytes = await readFile(path);
    const signature = bytes.subarray(0, 8).toString("hex");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (signature !== "89504e470d0a1a0a" || `${width}x${height}` !== icon.sizes) fail(`ícone inválido: ${icon.src}`);
  } catch { fail(`ícone ausente: ${icon.src}`); }
}
if (!process.exitCode) ok("ícones PNG e dimensões do manifest");

const html = await readFile(resolve(root, "site/index.html"), "utf8");
const css = await readFile(resolve(root, "site/styles.css"), "utf8");
const sw = await readFile(resolve(root, "site/sw.js"), "utf8");
const app = await readFile(resolve(root, "site/src/app.js"), "utf8");
if (!html.includes("./src/app.js") || !html.includes("./manifest.webmanifest") || !html.includes("id=\"view-root\"")) fail("shell HTML incompleto");
else ok("shell HTML e entrypoint");
if (/@import\s+url\(/i.test(css)) fail("CSS contém import remoto");
else ok("CSS sem dependência externa");
if (/style-src[^;]*unsafe-inline/i.test(html) || /\bstyle\s*=|\.style\./i.test(`${html}\n${app}`)) fail("shell usa estilo inline incompatível com a CSP");
if (!html.includes("https://*.workers.dev") || !html.includes("script-src 'self'")) fail("CSP não permite o Worker configurável ou enfraquece scripts");
else ok("CSP para script próprio e backend HTTPS");
if (!sw.includes("haba-study-os-shell-v3") || !sw.includes("./src/sync-queue.js") || !sw.includes("haba-study-os-content-v2") || !sw.includes("networkFirstContent") || !sw.includes("SKIP_WAITING") || !sw.includes("candidate?.schemaVersion === 2") || !sw.includes("candidate.studyDays.length === 75")) fail("service worker deve cachear o shell v3, incluir os módulos offline, validar o schema 2 e esperar atualização explícita");
else ok("service worker offline e atualização controlada");

const requiredStores = ["study_sessions", "question_attempts", "question_answers", "errors", "revisions", "progress", "reading_progress", "sync_queue", "content_versions", "backups"];
const storage = await readFile(resolve(root, "site/src/storage.js"), "utf8");
for (const store of requiredStores) if (!storage.includes(`${store}:`)) fail(`IndexedDB sem store ${store}`);
if (requiredStores.every(store => storage.includes(`${store}:`))) ok("stores operacionais IndexedDB");

const workflows = ["quality.yml", "sync-notion.yml", "deploy-pages.yml", "scheduled-sync.yml"];
let allWorkflows = true;
for (const workflow of workflows) {
  try { await access(resolve(root, ".github/workflows", workflow), constants.R_OK); }
  catch { allWorkflows = false; fail(`workflow obrigatório ausente: ${workflow}`); }
}
if (allWorkflows) ok("arquivos dos quatro workflows presentes");

const notionWorkflow = await readFile(resolve(root, ".github/workflows/sync-notion.yml"), "utf8");
if (!notionWorkflow.includes("git fetch origin main") || !notionWorkflow.includes("git rebase origin/main")) fail("sync editorial precisa rebasear o snapshot gerado antes do push");
else ok("sync editorial integra alterações concorrentes antes do push");

const sourceFiles = [
  "scripts/notion-sync-lib.mjs", "scripts/sync-notion.mjs", "scripts/quality.mjs", "backend/worker.mjs",
  "site/src/app.js", "site/src/backup.js", "site/src/content.js", "site/src/core.js",
  "site/src/preferences.js", "site/src/storage.js", "site/src/sync-queue.js", "site/src/ui.js", "site/sw.js"
];
for (const file of sourceFiles) {
  const result = spawnSync(process.execPath, ["--check", resolve(root, file)], { encoding: "utf8" });
  if (result.status !== 0) fail(`${file}: ${result.stderr || result.stdout}`);
}
if (!process.exitCode) ok("sintaxe JavaScript");

try {
  const raw = await readFile(resolve(root, "site/data/content.json"), "utf8");
  validateContentSnapshot(JSON.parse(raw));
  ok("snapshot editorial íntegro");
} catch (error) {
  if (error.code === "ENOENT") console.log("QUALITY INFO · snapshot ainda não sincronizado; o app exibirá o estado sem conteúdo");
  else fail(`snapshot inválido: ${error.message}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log("Quality gate concluído.");
