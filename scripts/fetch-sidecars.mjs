#!/usr/bin/env node
// Prepares the sidecar binaries Tauri bundles with the app:
//   src-tauri/binaries/tectonic-<triple>[.exe]   (downloaded)
//   src-tauri/binaries/quilltex-mcp-<triple>[.exe]  (built from crates/mcp)
// Usage: node scripts/fetch-sidecars.mjs [--target <triple>] [--skip-mcp]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, chmodSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const TECTONIC_VERSION = "0.17.0";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = join(root, "src-tauri", "binaries");
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

// Tectonic does not publish every triple; map to the closest asset.
function tectonicAsset(t) {
  const map = {
    "aarch64-apple-darwin": "aarch64-apple-darwin.tar.gz",
    "x86_64-apple-darwin": "x86_64-apple-darwin.tar.gz",
    "x86_64-pc-windows-msvc": "x86_64-pc-windows-msvc.zip",
    "aarch64-pc-windows-msvc": "x86_64-pc-windows-msvc.zip", // runs under emulation
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

async function fetchTectonic() {
  const dest = join(binDir, `tectonic-${target}${ext}`);
  if (existsSync(dest)) {
    console.log(`✓ ${dest} already present`);
    return;
  }
  const asset = tectonicAsset(target);
  const url = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/${asset}`;
  console.log(`↓ ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const work = join(tmpdir(), `quilltex-tectonic-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const archive = join(work, asset);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  // bsdtar (macOS, Windows 10+, most Linux) handles both .tar.gz and .zip.
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
  execFileSync("cargo", ["build", "--release", "-p", "quilltex-mcp", "--target", target], { cwd: root, stdio: "inherit" });
  const src = join(root, "target", target, "release", `quilltex-mcp${ext}`);
  const dest = join(binDir, `quilltex-mcp-${target}${ext}`);
  copyFileSync(src, dest);
  console.log(`✓ ${dest}`);
}

mkdirSync(binDir, { recursive: true });
await fetchTectonic();
if (!args.includes("--skip-mcp")) buildMcp();
