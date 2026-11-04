import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, Github, Loader2, Settings as Gear, Sparkles, Sigma, Trash2, XCircle, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { api, errorMessage, type GithubUser, type LoginCode, type UsageWindow } from "@/lib/ipc";
import { compactNumber } from "@/lib/format";
import { useApp, type SettingsTab } from "@/stores/app";
import { Dialog } from "./ui/Dialog";

const TABS: [SettingsTab, string, JSX.Element][] = [
  ["general", "General", <Gear size={15} key="g" />],
  ["github", "GitHub", <Github size={15} key="h" />],
  ["claude", "Claude Code", <Sparkles size={15} key="c" />],
  ["latex", "LaTeX", <Sigma size={15} key="l" />],
  ["uninstall", "Uninstall", <Trash2 size={15} key="u" />],
];

export function SettingsDialog() {
  const tab = useApp((s) => s.ui.settings);
  const setUi = useApp((s) => s.setUi);
  if (!tab) return null;
  return (
    <Dialog open wide bare title="Settings" onClose={() => setUi({ settings: null })}>
      <div className="settings">
        <nav className="settings-nav">
          {TABS.map(([id, label, icon]) => (
            <button key={id} className={`nav-item${tab === id ? " active" : ""}`} onClick={() => setUi({ settings: id })}>
              {icon}
              <span className="label">{label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-pane">
          {tab === "general" && <General />}
          {tab === "github" && <GithubTab />}
          {tab === "claude" && <ClaudeTab />}
          {tab === "latex" && <LatexTab />}
          {tab === "uninstall" && <UninstallTab />}
        </div>
      </div>
    </Dialog>
  );
}

function Status({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div className="status-line">
      {ok ? <CheckCircle2 size={15} style={{ color: "var(--green)" }} /> : <XCircle size={15} style={{ color: "var(--text-tertiary)" }} />}
      <span className="grow">{children}</span>
    </div>
  );
}

function General() {
  const { settings, saveSettings } = useApp();
  if (!settings) return null;
  return (
    <>
      <h3>General</h3>
      <div className="field">
        <label>Projects folder</label>
        <div className="row">
          <input className="input mono" readOnly value={settings.projectsRoot} style={{ fontSize: 12 }} />
          <button
            className="btn"
            onClick={async () => {
              const dir = await open({ directory: true, defaultPath: settings.projectsRoot });
              if (dir) await saveSettings({ projectsRoot: dir });
            }}
          >
            Change…
          </button>
        </div>
        <span className="hint">Every project is a normal folder here. You can open them with any editor.</span>
      </div>
      <div className="setting-row">
        <div className="text">
          <strong>Appearance</strong>
        </div>
        <div className="seg" style={{ width: 220, margin: 0 }}>
          {(["system", "light", "dark"] as const).map((t) => (
            <button key={t} className={settings.theme === t ? "on" : ""} onClick={() => saveSettings({ theme: t })}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div className="text">
          <strong>Editor font size</strong>
        </div>
        <div className="row" style={{ width: 120 }}>
          <input
            className="input"
            type="number"
            min={10}
            max={24}
            value={settings.editorFontSize}
            onChange={(e) => saveSettings({ editorFontSize: Number(e.target.value) || 13 })}
          />
          <span className="muted">px</span>
        </div>
      </div>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="field grow">
          <label>Commit author name</label>
          <input
            className="input"
            placeholder={settings.githubUser?.name || "From GitHub"}
            defaultValue={settings.gitName}
            onBlur={(e) => saveSettings({ gitName: e.target.value })}
          />
        </div>
        <div className="field grow">
          <label>Commit author email</label>
          <input
            className="input"
            placeholder={settings.githubUser?.email || "From GitHub"}
            defaultValue={settings.gitEmail}
            onBlur={(e) => saveSettings({ gitEmail: e.target.value })}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="text">
          <strong>Check origin every</strong>
          <span>Fetches in the background to keep sync badges current</span>
        </div>
        <select
          className="select"
          style={{ width: 130 }}
          value={settings.syncIntervalSecs}
          onChange={(e) => saveSettings({ syncIntervalSecs: Number(e.target.value) })}
        >
          <option value={60}>1 minute</option>
          <option value={120}>2 minutes</option>
          <option value={300}>5 minutes</option>
          <option value={900}>15 minutes</option>
        </select>
      </div>
    </>
  );
}

function GithubTab() {
  const { settings, info, refreshInfo, toast } = useApp();
  const [code, setCode] = useState<LoginCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [checking, setChecking] = useState(false);
  if (!settings || !info) return null;
  const user = settings.githubUser;

  const setUser = (githubUser: GithubUser | null) =>
    useApp.setState({ settings: { ...useApp.getState().settings!, githubUser } });

  const recheck = async () => {
    setChecking(true);
    setError(null);
    try {
      setUser((await api.githubStatus()).user);
      await refreshInfo();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const connect = async () => {
    setError(null);
    setWaiting(true);
    const unlisten = await listen<LoginCode>("github-login-code", (e) => {
      setCode(e.payload);
      void navigator.clipboard.writeText(e.payload.userCode).catch(() => {});
      void openUrl(e.payload.verificationUri);
    });
    try {
      const u = await api.githubLogin();
      setUser(u);
      await refreshInfo();
      toast(`Connected as @${u.login}`, "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      unlisten();
      setCode(null);
      setWaiting(false);
    }
  };

  return (
    <>
      <h3>GitHub</h3>
      {!info.ghInstalled ? (
        <div className="field">
          <span className="hint">
            Folio signs in through the GitHub CLI (<code>gh</code>). Install it, then come back here.
            {info.platform === "macos" && (
              <>
                {" "}With Homebrew: <code>brew install gh</code>
              </>
            )}
          </span>
          <div className="row">
            <button className="btn primary" onClick={() => openUrl("https://cli.github.com")}>
              <ExternalLink size={13} /> Get GitHub CLI
            </button>
            <button className="btn" disabled={checking} onClick={recheck}>
              {checking && <Loader2 size={13} className="spin" />} Check again
            </button>
          </div>
        </div>
      ) : info.githubConnected && user ? (
        <div className="status-line" style={{ padding: 12 }}>
          {user.avatarUrl && <img src={user.avatarUrl} alt="" width={32} height={32} style={{ borderRadius: 8 }} />}
          <div className="grow">
            <div style={{ fontWeight: 600, fontSize: 13 }}>{user.name || user.login}</div>
            <div className="muted">@{user.login}</div>
          </div>
          <button
            className="btn"
            title="Runs gh auth logout. This also signs out the GitHub CLI in your terminal."
            onClick={async () => {
              try {
                await api.githubLogout();
                setUser(null);
                await refreshInfo();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Sign out
          </button>
        </div>
      ) : code ? (
        <div className="field">
          <label>Enter this code on GitHub (copied to your clipboard)</label>
          <div className="device-code">{code.userCode}</div>
          <div className="row">
            <button className="btn" onClick={() => navigator.clipboard.writeText(code.userCode)}>
              <Copy size={13} /> Copy
            </button>
            <button className="btn" onClick={() => openUrl(code.verificationUri)}>
              <ExternalLink size={13} /> Open GitHub
            </button>
            <button className="btn" onClick={() => api.githubLoginCancel()}>
              Cancel
            </button>
            <div className="grow" />
            {waiting && (
              <span className="muted row">
                <Loader2 size={13} className="spin" /> Waiting for approval…
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="row">
          <button className="btn primary lg" disabled={waiting} onClick={connect}>
            {waiting ? <Loader2 size={15} className="spin" /> : <Github size={15} />} Sign in with GitHub
          </button>
          <button className="btn" disabled={checking || waiting} onClick={recheck}>
            {checking && <Loader2 size={13} className="spin" />} Already signed in with gh? Check again
          </button>
        </div>
      )}
      {error && <div className="banner red">{error}</div>}
      <span className="hint muted" style={{ fontSize: 12 }}>
        Folio uses your GitHub CLI sign-in and the git installed on this computer, with your own git config, credential
        helpers and SSH keys. It stores no tokens.
      </span>
    </>
  );
}

const WINDOW_LABELS = { five_hour: "Current session (5 hours)", seven_day: "Weekly (7 days)" };

function resetsIn(secs: number): string {
  const m = Math.max(0, Math.round((secs * 1000 - Date.now()) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function UsageBar({ w }: { w: UsageWindow }) {
  const pct = (f: number) => `${(Math.min(1, Math.max(0, f)) * 100).toFixed(1)}%`;
  const folio = w.totalTokens ? w.utilization * (w.folioTokens / w.totalTokens) : 0;
  const other = Math.max(0, w.utilization - folio);
  const limit = w.estimatedLimit;
  return (
    <div className="usage-window">
      <div className="usage-head">
        <strong>{WINDOW_LABELS[w.kind]}</strong>
        <span className="muted">resets in {resetsIn(w.resetsAt)}</span>
      </div>
      <div className="usage-bar" title={`${Math.round(w.utilization * 100)}% of the limit used`}>
        <div className="seg other" style={{ width: pct(other) }} />
        <div className="seg folio" style={{ width: pct(folio) }} />
      </div>
      <div className="usage-legend">
        <span>
          <i className="dot other" /> Everything else {compactNumber(w.totalTokens - w.folioTokens)}
        </span>
        <span>
          <i className="dot folio" /> Folio {compactNumber(w.folioTokens)}
        </span>
      </div>
      <div className="usage-numbers">
        <span>
          <strong>{w.totalTokens.toLocaleString()}</strong> tokens used · {Math.round(w.utilization * 100)}%
        </span>
        <span>{limit ? <>limit ≈ <strong>{limit.toLocaleString()}</strong> tokens</> : "limit unknown yet"}</span>
      </div>
    </div>
  );
}

function UsageSection() {
  const [windows, setWindows] = useState<UsageWindow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = async (refresh: boolean) => {
    setLoading(true);
    setError("");
    try {
      setWindows(await api.claudeUsage(refresh));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(false);
  }, []);
  return (
    <div className="usage">
      <div className="usage-title">
        <h4>Usage</h4>
        <button className="btn sm" disabled={loading} onClick={() => load(true)}>
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
        </button>
      </div>
      {windows?.map((w) => <UsageBar key={w.kind} w={w} />)}
      {error && <span className="hint muted">{error}</span>}
      {windows && (
        <span className="hint muted" style={{ fontSize: 12 }}>
          Percentages come from Claude Code. Claude doesn’t publish a token limit, so it is estimated from your recent
          usage (input, output and cache-write tokens in the window), which is counted from Claude Code’s local history.
        </span>
      )}
    </div>
  );
}

function ClaudeTab() {
  const { info, settings, saveSettings, refreshInfo, toast } = useApp();
  const [busy, setBusy] = useState(false);
  if (!settings) return null;
  const toggleMcp = async () => {
    setBusy(true);
    try {
      if (settings.mcpRegistered) await api.mcpUnregister();
      else await api.mcpRegister();
      useApp.setState({ settings: await api.getSettings() });
      toast(settings.mcpRegistered ? "Removed from Claude Code" : "Folio is now available in Claude Code", "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h3>Claude Code</h3>
      <Status ok={!!info?.claude}>
        {info?.claude ? (
          <>
            Found <span className="mono">{info.claude}</span>
          </>
        ) : (
          "Claude Code CLI not found. Install it and run `claude` once to sign in."
        )}
      </Status>
      <div className="field">
        <label>Custom path to claude (optional)</label>
        <input
          className="input mono"
          placeholder="Auto-detect"
          defaultValue={settings.claudePath}
          onBlur={async (e) => {
            await saveSettings({ claudePath: e.target.value.trim() });
            await refreshInfo();
          }}
        />
      </div>
      <div className="setting-row">
        <div className="text">
          <strong>Use Folio from Claude Code in your terminal</strong>
          <span>Registers Folio’s MCP server with Claude Code (user scope) so `claude` can manage your projects anywhere.</span>
        </div>
        <button className={`switch${settings.mcpRegistered ? " on" : ""}`} disabled={busy || !info?.claude} onClick={toggleMcp} />
      </div>
      {info?.claude && <UsageSection />}
      <div className="banner blue">
        <span>
          The assistant only gets Folio’s tools (projects, files, compile, git). Shell, file system and web tools are
          disabled, and it runs from an empty folder, so it can’t read or change anything outside your projects.
        </span>
      </div>
    </>
  );
}

function LatexTab() {
  const info = useApp((s) => s.info);
  return (
    <>
      <h3>LaTeX</h3>
      <Status ok={!!info?.tectonic}>
        {info?.tectonic ? "Tectonic is bundled and ready." : "Bundled Tectonic is missing. Run `npm run sidecars`."}
      </Status>
      <Status ok={!!info?.systemTex}>
        {info?.systemTex ? (
          <>
            System TeX found at <span className="mono">{info.systemTex}</span> (pdfLaTeX, XeLaTeX and LuaLaTeX via latexmk).
          </>
        ) : (
          "No system TeX distribution. That’s fine: Tectonic covers most documents. Install MacTeX, TeX Live or MiKTeX to use pdfLaTeX, LuaLaTeX or shell-escape packages."
        )}
      </Status>
      <span className="hint muted" style={{ fontSize: 12 }}>
        Tectonic downloads the packages a document needs on first compile and caches them inside Folio’s own cache folder.
        Pick the compiler per project under Project settings.
      </span>
    </>
  );
}

function UninstallTab() {
  const { openDialog, setUi } = useApp();
  return (
    <>
      <h3>Uninstall</h3>
      <p className="muted" style={{ margin: 0 }}>
        Folio keeps everything in its own folders: settings, the TeX package cache and chat history. Uninstalling removes
        all of it, the saved GitHub token and the Claude Code registration. You choose whether your projects stay.
      </p>
      <button
        className="btn danger"
        style={{ alignSelf: "flex-start" }}
        onClick={() => {
          setUi({ settings: null });
          openDialog({ kind: "uninstall" });
        }}
      >
        <Trash2 size={14} /> Uninstall Folio…
      </button>
    </>
  );
}
