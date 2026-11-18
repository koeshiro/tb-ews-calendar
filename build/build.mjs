// build/build.mjs — package the add-on into a distributable .xpi.
// A .xpi is a zip with the add-on files at the archive root (forward-slash
// entry names). We stage the required files into a temp dir, then zip them
// with .NET's System.IO.Compression.ZipArchive via PowerShell (Windows).
// Output: dist/<name>-<version>.xpi
//
//   node build/build.mjs            -> build into dist/
//
import {
  cpSync,
  mkdirSync,
  rmSync,
  renameSync,
  existsSync,
  statSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(DIST, "_stage");

// Files / folders to include, relative to ROOT.
// This is a WebExtension (MV2) with a Thunderbird experiment: manifest.json is
// the entry point; the experiment api.js loads everything else at runtime, so
// the package just needs the files on disk. Name/version come from
// manifest.json itself.
const INCLUDE = [
  "manifest.json",
  "lib", // EWS layer (client/xml/datetime/item/sync/transport), dual-mode for Node tests
  "experiments", // schema.json + api.js + loader + provider/config/migration/startup
  "options", // settings page
  "popup", // unified-toolbar button popup
  "_locales", // en + ru messages for the UI pages
  "icons",
];

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function copy(src, dest) {
  const st = statSync(src);
  if (st.isDirectory()) {
    ensureDir(dest);
    for (const entry of readdirSync(src)) {
      copy(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    ensureDir(path.dirname(dest));
    cpSync(src, dest);
  }
}

function main() {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const base = `${manifest.name.replace(/\s+/g, "-").toLowerCase()}-${manifest.version}`;
  const outFile = path.join(DIST, base + ".xpi");
  const zipFile = path.join(DIST, base + ".zip");

  // Reset stage.
  if (existsSync(STAGE)) rmSync(STAGE, { recursive: true, force: true });
  ensureDir(STAGE);

  for (const rel of INCLUDE) {
    const src = path.join(ROOT, rel);
    if (!existsSync(src)) {
      console.warn(`[build] skipping missing: ${rel}`);
      continue;
    }
    copy(src, path.join(STAGE, rel));
  }

  ensureDir(DIST);
  if (existsSync(zipFile)) rmSync(zipFile);
  if (existsSync(outFile)) rmSync(outFile);

  // Compress-Archive stores backslash entry names, which break Thunderbird's
  // zip/JAR reader (it resolves forward-slash paths). Build the archive with
  // System.IO.Compression.ZipArchive using explicit forward-slash names, then
  // rename .zip -> .xpi (a .xpi is just a zip with files at the archive root).
  const psPath = path.join(DIST, "_zip.ps1");
  const ps = [
    "param([string]$Stage,[string]$Out)",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "if (Test-Path $Out) { Remove-Item $Out -Force }",
    "$zip = [System.IO.Compression.ZipFile]::Open($Out,'Create')",
    "try {",
    "  Get-ChildItem -LiteralPath $Stage -Recurse -File | ForEach-Object {",
    "    $rel = $_.FullName.Substring($Stage.Length).Replace('\\','/')",
    "    while ($rel.StartsWith('/')) { $rel = $rel.Substring(1) }",
    "    $entry = $zip.CreateEntry($rel,[System.IO.Compression.CompressionLevel]::Optimal)",
    "    $es = $entry.Open(); $fs = [System.IO.File]::OpenRead($_.FullName)",
    "    $fs.CopyTo($es); $fs.Close(); $es.Close()",
    "  }",
    "} finally { $zip.Dispose() }",
  ].join("\r\n");
  writeFileSync(psPath, ps);
  execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psPath, STAGE, zipFile], {
    stdio: "inherit",
  });
  rmSync(psPath, { force: true });

  renameSync(zipFile, outFile);
  rmSync(STAGE, { recursive: true, force: true });
  console.log(`[build] wrote ${outFile}`);
}

try {
  main();
} catch (e) {
  console.error("[build] failed:", e);
  process.exit(1);
}
