#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const confPath = join(root, "src-tauri", "tauri.conf.json");

const sh = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { cwd: root, encoding: "utf8", ...opts });
const run = (cmd, cmdArgs, env) =>
  execFileSync(cmd, cmdArgs, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
const gh = (ghArgs) => sh("gh", ghArgs).trim();
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const target = sh("rustc", ["-vV"]).match(/^host: (.+)$/m)[1].trim();
const arch = target.split("-")[0];
const os = target.includes("windows")
  ? "windows"
  : target.includes("apple")
    ? "darwin"
    : "linux";
const repo = sh("git", ["remote", "get-url", "origin"])
  .trim()
  .match(/github\.com[:/](.+?)(?:\.git)?$/)[1];

if (!args.includes("--allow-dirty") && sh("git", ["status", "--porcelain"]).trim())
  fail("working tree has uncommitted changes (use --allow-dirty to ignore)");
const sha = sh("git", ["rev-parse", "HEAD"]).trim();
run("git", ["fetch", "origin", "--quiet"]);
if (!sh("git", ["branch", "-r", "--contains", sha]).trim())
  fail(`${sha.slice(0, 7)} is not on origin yet, push it first`);

const keyFile = join(homedir(), ".tauri", "quilltex.key");
const signEnv = {};
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  if (!existsSync(keyFile))
    fail(`no signing key: set TAURI_SIGNING_PRIVATE_KEY or create ${keyFile}`);
  signEnv.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyFile, "utf8").trim();
}
if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
  const pw = `${keyFile}.password`;
  signEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = existsSync(pw)
    ? readFileSync(pw, "utf8").trim()
    : "";
}

const fetchReleases = () =>
  JSON.parse(gh(["api", `repos/${repo}/releases?per_page=50`]));
const findRelease = (releases) =>
  releases.find((r) => r.target_commitish === sha && r.tag_name.startsWith("v"));
const releases = fetchReleases();
const conf = JSON.parse(readFileSync(confPath, "utf8"));
const majorMinor = conf.version.split(".").slice(0, 2).join(".");
let release = findRelease(releases);
let tag;
if (release) {
  tag = release.tag_name;
  console.log(`✓ reusing ${tag} for ${sha.slice(0, 7)}`);
} else {
  const patches = releases
    .map((r) => r.tag_name.match(new RegExp(`^v${majorMinor.replace(".", "\\.")}\\.(\\d+)$`)))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  tag = `v${majorMinor}.${Math.max(0, ...patches) + 1}`;
  console.log(`… building ${tag}, the release is created only if everything succeeds`);
}
const version = tag.slice(1);

if (!args.includes("--skip-tests"))
  run("cargo", ["test", "-p", "quilltex-core", "-p", "quilltex-mcp"]);
run("node", [
  "scripts/fetch-sidecars.mjs", "--target", target, "--publish-engines",
]);
const originalConf = readFileSync(confPath, "utf8");
const tauriCli = join(
  dirname(createRequire(import.meta.url).resolve("@tauri-apps/cli/package.json")),
  "tauri.js",
);
try {
  writeFileSync(confPath, `${JSON.stringify({ ...conf, version }, null, 2)}\n`);
  run("node", [tauriCli, "build", "--target", target], {
    ...signEnv,
    ...(os === "darwin" ? { APPLE_SIGNING_IDENTITY: "-", CI: "true" } : {}),
  });
} finally {
  writeFileSync(confPath, originalConf);
}

const targetDir = JSON.parse(
  sh("cargo", ["metadata", "--format-version", "1", "--no-deps"]),
).target_directory;
const bundleDir = join(targetDir, target, "release", "bundle");
const pick = (dir, suffix) => {
  const d = join(bundleDir, dir);
  const name = existsSync(d)
    ? readdirSync(d).find((f) => f.endsWith(suffix) && (f.includes(version) || dir === "macos"))
    : undefined;
  if (!name) fail(`missing *${suffix} in ${d}`);
  return join(d, name);
};
const staging = join(tmpdir(), `quilltex-release-${Date.now()}`);
mkdirSync(staging, { recursive: true });
const uploads = [];
const stage = (file, name = file.split(/[\\/]/).pop()) => {
  const dest = join(staging, name);
  copyFileSync(file, dest);
  uploads.push(dest);
  return name;
};
const updater = {};
const addUpdater = (keys, file, name) => {
  const asset = stage(file, name);
  const sig = readFileSync(`${file}.sig`, "utf8").trim();
  stage(`${file}.sig`, `${asset}.sig`);
  for (const k of keys) updater[k] = { asset, sig };
};
if (os === "windows") {
  addUpdater(
    [`windows-${arch}`, `windows-${arch}-nsis`],
    pick("nsis", "-setup.exe"),
  );
} else if (os === "darwin") {
  stage(pick("dmg", ".dmg"));
  addUpdater(
    [`darwin-${arch}`, `darwin-${arch}-app`],
    pick("macos", ".app.tar.gz"),
    `QuillTex_${arch}.app.tar.gz`,
  );
} else {
  addUpdater(
    [`linux-${arch}`, `linux-${arch}-appimage`],
    pick("appimage", ".AppImage"),
  );
  addUpdater([`linux-${arch}-deb`], pick("deb", ".deb"));
}

let created = false;
if (!release) {
  release = findRelease(fetchReleases());
  if (release && release.tag_name !== tag)
    fail(`${release.tag_name} was created for ${sha.slice(0, 7)} during the build, but this build is ${tag}; run again`);
  if (!release) {
    const notes = sh("git", ["log", "-1", "--format=%B"]).trim();
    gh([
      "release", "create", tag, "--repo", repo, "--draft", "--target", sha,
      "--title", `QuillTex ${tag}`, "--notes", notes,
    ]);
    release = { tag_name: tag, draft: true };
    created = true;
    console.log(`✓ created draft ${tag}`);
  }
}

const latestPath = join(staging, "latest.json");
let latest = { version, notes: "", pub_date: new Date().toISOString(), platforms: {} };
try {
  const dl = join(staging, "existing");
  gh(["release", "download", tag, "--repo", repo, "-p", "latest.json", "-D", dl, "--clobber"]);
  latest = JSON.parse(readFileSync(join(dl, "latest.json"), "utf8"));
} catch {
  console.log("… no latest.json yet, starting a new one");
}
latest.version = version;
latest.pub_date = new Date().toISOString();
for (const [key, { asset, sig }] of Object.entries(updater)) {
  latest.platforms[key] = {
    signature: sig,
    url: `https://github.com/${repo}/releases/latest/download/${asset}`,
  };
}
writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
uploads.push(latestPath);

try {
  gh(["release", "upload", tag, "--repo", repo, "--clobber", ...uploads]);
} catch (e) {
  if (created) {
    gh(["release", "delete", tag, "--repo", repo, "--yes"]);
    console.error(`✗ upload failed, deleted draft ${tag}`);
  }
  throw e;
}
rmSync(staging, { recursive: true, force: true });
console.log(`✓ uploaded ${os} build to ${tag}`);

const platforms = Object.keys(latest.platforms);
const complete = ["windows-", "darwin-"].every((p) =>
  platforms.some((k) => k.startsWith(p)),
);
if (release.draft && !args.includes("--no-publish") && (complete || args.includes("--publish"))) {
  gh(["release", "edit", tag, "--repo", repo, "--draft=false", "--latest"]);
  console.log(`✓ published ${tag} as latest`);
} else if (release.draft) {
  console.log(`… ${tag} stays a draft until the other platform runs (or pass --publish)`);
}
