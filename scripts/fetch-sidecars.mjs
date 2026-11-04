#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TECTONIC_VERSION = "0.17.0";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = join(root, "src-tauri", "binaries");
const resourcesDir = join(root, "src-tauri", "resources");
const TINYTEX_VERSION = readFileSync(
  join(root, "crates", "core", "src", "texlive.rs"),
  "utf8",
).match(/const TINYTEX_VERSION: &str = "([^"]+)"/)[1];
const args = process.argv.slice(2);
const target =
  args[args.indexOf("--target") + 1] && args.includes("--target")
    ? args[args.indexOf("--target") + 1]
    : hostTriple();
const isWin = target.includes("windows");
const ext = isWin ? ".exe" : "";

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  return out.match(/^host: (.+)$/m)[1].trim();
}

function tectonicAsset(t) {
  const map = {
    "aarch64-apple-darwin": "aarch64-apple-darwin.tar.gz",
    "x86_64-apple-darwin": "x86_64-apple-darwin.tar.gz",
    "x86_64-pc-windows-msvc": "x86_64-pc-windows-msvc.zip",
    "aarch64-pc-windows-msvc": "x86_64-pc-windows-msvc.zip",
    "x86_64-unknown-linux-gnu": "x86_64-unknown-linux-musl.tar.gz",
    "aarch64-unknown-linux-gnu": "aarch64-unknown-linux-musl.tar.gz",
  };
  const suffix = map[t];
  if (!suffix) throw new Error(`no tectonic build for ${t}`);
  return `tectonic-${TECTONIC_VERSION}-${suffix}`;
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (entry === name) return p;
  }
  return null;
}

function download(url, dest) {
  console.log(`↓ ${url}`);
  execFileSync(
    "curl",
    [
      "-fsSL",
      "--retry",
      "5",
      "--retry-all-errors",
      "--retry-delay",
      "5",
      "-o",
      dest,
      url,
    ],
    { stdio: "inherit" },
  );
}

function tinytexAsset(t) {
  const platform = t.includes("apple-darwin")
    ? "darwin"
    : t.includes("windows")
      ? "windows"
      : t.startsWith("aarch64")
        ? "linux-arm64"
        : "linux-x86_64";
  return `TinyTeX-1-${platform}-v${TINYTEX_VERSION}.${isWin ? "exe" : "tar.xz"}`;
}

async function prepareEngines() {
  const cacheDir = join(resourcesDir, "tectonic-cache");
  const texliveDir = join(resourcesDir, "texlive");
  const stampFile = join(resourcesDir, ".stamp");
  const templates = readFileSync(
    join(root, "crates", "core", "src", "templates.rs"),
  );
  const stamp = JSON.stringify({
    target,
    tectonic: TECTONIC_VERSION,
    tinytex: TINYTEX_VERSION,
    templates: createHash("sha256").update(templates).digest("hex"),
  });
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) {
    console.log("✓ bundled engine files are up to date");
    return;
  }
  if (target !== hostTriple())
    throw new Error(`engine files must be prepared on a ${target} machine`);

  const work = join(tmpdir(), `quilltex-engines-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const asset = tinytexAsset(target);
  const archive = join(work, asset);
  download(
    `https://github.com/rstudio/tinytex-releases/releases/download/v${TINYTEX_VERSION}/${asset}`,
    archive,
  );
  console.log("⚙ compiling the templates with Tectonic and TeX Live");
  execFileSync(
    "cargo",
    [
      "run",
      "--release",
      "-p",
      "quilltex-core",
      "--example",
      "prepare-engines",
      "--",
      work,
      join(binDir, `tectonic-${target}${ext}`),
      archive,
    ],
    { cwd: root, stdio: "inherit" },
  );

  rmSync(cacheDir, { recursive: true, force: true });
  cpSync(join(work, "tectonic-cache"), cacheDir, { recursive: true });
  rmSync(texliveDir, { recursive: true, force: true });
  mkdirSync(texliveDir, { recursive: true });
  rmSync(join(work, "TinyTeX", "tlpkg", "backups"), {
    recursive: true,
    force: true,
  });
  const packed = join(
    texliveDir,
    `TinyTeX-v${TINYTEX_VERSION}.${isWin ? "zip" : "tar.xz"}`,
  );
  console.log(`⚙ packing ${packed}`);
  execFileSync(
    "tar",
    [isWin ? "-a" : "-J", "-cf", packed, "-C", work, "TinyTeX"],
    {
      stdio: "inherit",
      env: { ...process.env, XZ_OPT: "-T0" },
    },
  );
  rmSync(work, { recursive: true, force: true });
  writeFileSync(stampFile, stamp);
  console.log(`✓ ${resourcesDir}`);
}

async function fetchTectonic() {
  const dest = join(binDir, `tectonic-${target}${ext}`);
  if (existsSync(dest)) {
    console.log(`✓ ${dest} already present`);
    return;
  }
  const asset = tectonicAsset(target);
  const url = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/${asset}`;
  const work = join(tmpdir(), `quilltex-tectonic-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const archive = join(work, asset);
  download(url, archive);
  execFileSync("tar", ["-xf", archive, "-C", work]);
  const bin = findFile(work, `tectonic${ext}`);
  if (!bin) throw new Error("tectonic binary not found in archive");
  copyFileSync(bin, dest);
  if (!isWin) chmodSync(dest, 0o755);
  rmSync(work, { recursive: true, force: true });
  console.log(`✓ ${dest}`);
}

function buildMcp() {
  console.log("⚙ building quilltex-mcp");
  execFileSync(
    "cargo",
    ["build", "--release", "-p", "quilltex-mcp", "--target", target],
    { cwd: root, stdio: "inherit" },
  );
  const src = join(root, "target", target, "release", `quilltex-mcp${ext}`);
  const dest = join(binDir, `quilltex-mcp-${target}${ext}`);
  copyFileSync(src, dest);
  console.log(`✓ ${dest}`);
}

mkdirSync(binDir, { recursive: true });
await fetchTectonic();
if (!args.includes("--skip-mcp")) buildMcp();
if (!args.includes("--skip-engines")) await prepareEngines();
