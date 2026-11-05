import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowDownToLine,
  CheckCircle2,
  ChevronRight,
  Copy,
  ExternalLink,
  Settings as Gear,
  Github,
  Keyboard,
  Loader2,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Sigma,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { compactNumber, formatBytes } from "@/lib/format";
import {
  LANGUAGES,
  type Language,
  type MessageKey,
  type TFunction,
  t as translate,
  useLanguage,
  useT,
} from "@/lib/i18n";
import { T } from "@/lib/i18n/T";
import {
  api,
  type EngineEntry,
  errorMessage,
  type GithubUser,
  type Installed,
  type LoginCode,
  type StorageUsage,
  type TexPackage,
  type UsageWindow,
} from "@/lib/ipc";
import {
  ACTIONS,
  bindingFor,
  eventToCombo,
  formatComboParts,
  isCustomized,
  type KeyAction,
  setRecording,
  useKeybinds,
  validate,
} from "@/lib/keybinds";
import {
  applyTheme,
  BASE_THEMES,
  BUILTIN_THEMES,
  clampFontSize,
  FONT_MAX,
  FONT_MIN,
  findTheme,
  newThemeId,
  PALETTE_FIELDS,
  snapshotTheme,
  type Theme,
} from "@/lib/themes";
import { type SettingsTab, useApp } from "@/stores/app";
import { useUpdater } from "@/stores/updater";
import { Dialog } from "./ui/Dialog";
import { SegmentedBar } from "./ui/SegmentedBar";
import { Select } from "./ui/Select";
import {
  Note,
  Page,
  RefreshButton,
  Row,
  Rows,
  Section,
} from "./ui/SettingsLayout";

export const TABS: [SettingsTab, MessageKey, JSX.Element][] = [
  ["general", "settings.tab.general", <Gear size={15} key="g" />],
  ["appearance", "settings.tab.appearance", <Palette size={15} key="p" />],
  ["keybinds", "settings.tab.keybinds", <Keyboard size={15} key="k" />],
  ["github", "settings.tab.github", <Github size={15} key="h" />],
  ["claude", "settings.tab.claude", <Sparkles size={15} key="c" />],
  ["latex", "settings.tab.latex", <Sigma size={15} key="l" />],
  ["uninstall", "settings.tab.uninstall", <Trash2 size={15} key="u" />],
];

export function SettingsDialog() {
  const t = useT();
  const tab = useApp((s) => s.ui.settings);
  const setUi = useApp((s) => s.setUi);
  if (!tab) return null;
  return (
    <Dialog
      open
      wide
      bare
      title={t("settings.title")}
      onClose={() => setUi({ settings: null })}
    >
      <div className="settings">
        <nav className="settings-nav">
          {TABS.map(([id, label, icon]) => (
            <button
              key={id}
              className={`nav-item${tab === id ? " active" : ""}`}
              onClick={() => setUi({ settings: id })}
            >
              {icon}
              <span className="label">{t(label)}</span>
            </button>
          ))}
        </nav>
        <div className="settings-pane">
          {tab === "general" && <General />}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "keybinds" && <KeybindsTab />}
          {tab === "github" && <GithubTab />}
          {tab === "claude" && <ClaudeTab />}
          {tab === "latex" && <LatexTab />}
          {tab === "uninstall" && <UninstallTab />}
        </div>
      </div>
    </Dialog>
  );
}

function StatusIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 size={16} style={{ color: "var(--green)" }} />
  ) : (
    <XCircle size={16} style={{ color: "var(--text-tertiary)" }} />
  );
}

function ThemeSwatch({ theme }: { theme: Theme }) {
  const p = theme.palette;
  return (
    <span className="theme-swatch" style={{ background: p.bg }}>
      <i style={{ background: p.surface }} />
      <i style={{ background: p.accent }} />
      <i style={{ background: p.command }} />
      <i style={{ background: p.string }} />
    </span>
  );
}

function ThemeCard({
  name,
  active,
  swatch,
  onSelect,
  onEdit,
}: {
  name: string;
  active: boolean;
  swatch: ReactNode;
  onSelect: () => void;
  onEdit?: () => void;
}) {
  const t = useT();
  return (
    <div className={`theme-card${active ? " on" : ""}`}>
      <button className="theme-pick" onClick={onSelect}>
        {swatch}
        <span className="theme-name">{name}</span>
      </button>
      {onEdit && (
        <button
          className="theme-edit"
          title={t("settings.theme.edit")}
          onClick={onEdit}
        >
          <Pencil size={12} />
        </button>
      )}
    </div>
  );
}

function ThemeEditor({
  initial,
  onClose,
}: {
  initial: Theme;
  onClose: () => void;
}) {
  const t = useT();
  const { saveCustomTheme, deleteCustomTheme, saveSettings, customThemes } =
    useApp();
  const isNew = !customThemes.some((t) => t.id === initial.id);
  const [draft, setDraft] = useState(initial);

  useEffect(() => {
    applyTheme(draft.id, [{ ...draft, custom: true }]);
  }, [draft]);

  const restore = () => {
    const s = useApp.getState();
    applyTheme(s.settings?.theme ?? "system", s.customThemes);
  };

  useEffect(() => restore, []);

  const save = async () => {
    const name = draft.name.trim() || t("settings.theme.defaultName");
    saveCustomTheme({ ...draft, name });
    await saveSettings({ theme: draft.id });
    onClose();
  };

  return (
    <div className="theme-editor">
      <div className="theme-editor-head">
        <input
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          className="input"
          placeholder={t("settings.theme.namePlaceholder")}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <div className="seg" style={{ width: 140, margin: 0 }}>
          {(["light", "dark"] as const).map((m) => (
            <button
              key={m}
              className={draft.mode === m ? "on" : ""}
              onClick={() => setDraft({ ...draft, mode: m })}
            >
              {t(
                m === "light" ? "settings.theme.light" : "settings.theme.dark",
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="theme-colors">
        {PALETTE_FIELDS.map(([key, label]) => (
          <label key={key} className="theme-color">
            <input
              type="color"
              value={draft.palette[key]}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  palette: { ...draft.palette, [key]: e.target.value },
                })
              }
            />
            <span>{t(label)}</span>
          </label>
        ))}
      </div>
      <div className="theme-editor-actions">
        {!isNew && (
          <button
            className="btn danger"
            onClick={async () => {
              await deleteCustomTheme(initial.id);
              onClose();
            }}
          >
            {t("common.delete")}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button className="btn primary" onClick={save}>
          {t("settings.theme.save")}
        </button>
      </div>
    </div>
  );
}

function AppearanceTab() {
  const t = useT();
  const language = useLanguage((s) => s.language);
  const setLanguage = useLanguage((s) => s.setLanguage);
  const { settings, saveSettings, customThemes } = useApp();
  const [editing, setEditing] = useState<Theme | null>(null);
  if (!settings) return null;

  const size = clampFontSize(settings.editorFontSize);
  const [draft, setDraft] = useState(String(size));
  useEffect(() => setDraft(String(size)), [size]);
  const commit = (raw: string) => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(n)) {
      setDraft(String(size));
      return;
    }
    const next = clampFontSize(n);
    setDraft(String(next));
    if (next !== size) void saveSettings({ editorFontSize: next });
  };

  const startNew = () => {
    const base = findTheme(settings.theme, customThemes) ?? snapshotTheme();
    setEditing({
      ...base,
      id: newThemeId(),
      name: t("settings.theme.myTheme"),
      custom: true,
    });
  };

  return (
    <Page title={t("settings.tab.appearance")}>
      <Section
        title={t("settings.theme.title")}
        description={t("settings.theme.desc")}
      >
        {editing && (
          <ThemeEditor
            key={editing.id}
            initial={editing}
            onClose={() => setEditing(null)}
          />
        )}
        <div className="theme-grid">
          {BASE_THEMES.map((theme) => (
            <ThemeCard
              key={theme.id}
              name={t(theme.name)}
              active={settings.theme === theme.id}
              swatch={
                <span className={`theme-swatch base-${theme.id}`}>
                  <i />
                  <i />
                  <i />
                </span>
              }
              onSelect={() => saveSettings({ theme: theme.id })}
            />
          ))}
          {[...BUILTIN_THEMES, ...customThemes].map((theme) => (
            <ThemeCard
              key={theme.id}
              name={theme.name}
              active={settings.theme === theme.id}
              swatch={<ThemeSwatch theme={theme} />}
              onSelect={() => saveSettings({ theme: theme.id })}
              onEdit={theme.custom ? () => setEditing(theme) : undefined}
            />
          ))}
          {!editing && (
            <button className="theme-card theme-add" onClick={startNew}>
              <Plus size={18} />
              <span className="theme-name">{t("settings.theme.new")}</span>
            </button>
          )}
        </div>
      </Section>
      <Section>
        <Rows>
          <Row
            title={t("settings.textSize.title")}
            description={t("settings.textSize.desc", {
              min: FONT_MIN,
              max: FONT_MAX,
            })}
          >
            <input
              className="input"
              style={{ width: 72 }}
              type="number"
              min={FONT_MIN}
              max={FONT_MAX}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= FONT_MIN && n <= FONT_MAX)
                  void saveSettings({ editorFontSize: n });
              }}
              onBlur={(e) => commit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit(e.currentTarget.value);
              }}
            />
            <span className="muted">px</span>
          </Row>
        </Rows>
      </Section>
      <Section
        title={t("settings.language.title")}
        description={t("settings.language.desc")}
      >
        <Rows>
          <Row title={t("settings.language.row")}>
            <Select
              width={180}
              value={language}
              options={LANGUAGES.map((l) => ({ value: l.id, label: l.name }))}
              onChange={(id) => setLanguage(id as Language)}
            />
          </Row>
        </Rows>
      </Section>
    </Page>
  );
}

function KeyChip({ action }: { action: KeyAction }) {
  const t = useT();
  const { overrides, setBinding, reset } = useKeybinds();
  const [recording, setRec] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const combo = bindingFor(action.id, overrides);

  useEffect(() => {
    if (!recording) return;
    setRecording(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRec(false);
        setError(null);
        return;
      }
      const next = eventToCombo(e);
      if (!next) return;
      const problem = validate(action, next, overrides);
      if (problem) return setError(problem);
      setBinding(action.id, next);
      setRec(false);
      setError(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setRecording(false);
    };
  }, [recording, overrides]);

  const custom = isCustomized(action.id, overrides);
  return (
    <>
      <span className="kb-reset-slot">
        {custom && (
          <button
            className="kb-reset"
            title={t("settings.keys.restore")}
            onClick={() => reset(action.id)}
          >
            <RotateCcw size={12} />
          </button>
        )}
      </span>
      <span className="kb-chip-wrap">
        <button
          className={`kb-chip${recording ? " rec" : ""}${combo ? "" : " add"}${custom ? " custom" : ""}`}
          title={combo ? t("settings.keys.change") : t("settings.keys.set")}
          onClick={() => {
            setError(null);
            setRec((r) => !r);
          }}
          onBlur={() => {
            setRec(false);
            setError(null);
          }}
        >
          {recording ? (
            t("settings.keys.press")
          ) : combo ? (
            formatComboParts(combo).map((part, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="kb-plus">+</span>}
                {part}
              </Fragment>
            ))
          ) : (
            <>
              <Plus size={16} /> {t("settings.keys.add")}
            </>
          )}
        </button>
        {combo && !recording && (
          <button
            className="kb-remove"
            title={t("settings.keys.remove")}
            onClick={() => setBinding(action.id, null)}
          >
            <X size={10} />
          </button>
        )}
        {error && <span className="kb-error">{error}</span>}
      </span>
    </>
  );
}

function KeybindsTab() {
  const t = useT();
  const { overrides, resetAll } = useKeybinds();
  const groups = [...new Set(ACTIONS.map((a) => a.group))];
  return (
    <Page
      title={t("settings.tab.keybinds")}
      actions={
        <button
          className="btn"
          disabled={Object.keys(overrides).length === 0}
          onClick={resetAll}
        >
          {t("settings.keys.resetAll")}
        </button>
      }
    >
      {groups.map((group) => (
        <Section key={group} title={t(group)}>
          <Rows>
            {ACTIONS.filter((a) => a.group === group).map((a) => (
              <Row key={a.id} title={t(a.label)}>
                <KeyChip action={a} />
              </Row>
            ))}
          </Rows>
        </Section>
      ))}
      <Note>{t("settings.keys.note")}</Note>
    </Page>
  );
}

function General() {
  const t = useT();
  const { settings, saveSettings } = useApp();
  if (!settings) return null;
  return (
    <Page title={t("settings.tab.general")}>
      <Section
        title={t("settings.general.folder")}
        description={t("settings.general.folderDesc")}
      >
        <div className="row">
          <input
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            className="input mono"
            readOnly
            value={settings.projectsRoot}
            style={{ fontSize: 12 }}
          />
          <button
            className="btn"
            onClick={async () => {
              const dir = await open({
                directory: true,
                defaultPath: settings.projectsRoot,
              });
              if (dir) await saveSettings({ projectsRoot: dir });
            }}
          >
            {t("settings.general.change")}
          </button>
        </div>
      </Section>
      <StorageOverview />
      <AboutSection />
    </Page>
  );
}

function GithubTab() {
  const t = useT();
  const { settings, info, refreshInfo, toast, saveSettings } = useApp();
  const [code, setCode] = useState<LoginCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [checking, setChecking] = useState(false);
  if (!settings || !info) return null;
  const user = settings.githubUser;

  const setUser = (githubUser: GithubUser | null) =>
    useApp.setState({
      settings: { ...useApp.getState().settings!, githubUser },
    });

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
      toast(t("settings.github.connected", { login: u.login }), "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      unlisten();
      setCode(null);
      setWaiting(false);
    }
  };

  return (
    <Page title="GitHub">
      <Section title={t("settings.github.account")}>
        {!info.ghInstalled ? (
          <Rows>
            <Row
              title={t("settings.github.cliRequired")}
              description={
                <>
                  <T
                    k="settings.github.cliDesc"
                    values={{ gh: <code>gh</code> }}
                  />
                  {info.platform === "macos" && (
                    <T
                      k="settings.github.brew"
                      values={{ cmd: <code>brew install gh</code> }}
                    />
                  )}
                </>
              }
            >
              <button
                className="btn primary"
                onClick={() => openUrl("https://cli.github.com")}
              >
                <ExternalLink size={13} /> {t("settings.github.getCli")}
              </button>
              <button className="btn" disabled={checking} onClick={recheck}>
                {checking && <Loader2 size={13} className="spin" />}{" "}
                {t("settings.github.checkAgain")}
              </button>
            </Row>
          </Rows>
        ) : info.githubConnected && user ? (
          <Rows>
            <Row
              title={user.name || user.login}
              description={`@${user.login}`}
              leading={
                user.avatarUrl && (
                  <img
                    src={user.avatarUrl}
                    alt=""
                    width={32}
                    height={32}
                    style={{ borderRadius: 8 }}
                  />
                )
              }
            >
              <button
                className="btn"
                title={t("settings.github.signOutTitle")}
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
                {t("settings.github.signOut")}
              </button>
            </Row>
          </Rows>
        ) : code ? (
          <>
            <div className="device-code">{code.userCode}</div>
            <div className="row">
              <button
                className="btn"
                onClick={() => navigator.clipboard.writeText(code.userCode)}
              >
                <Copy size={13} /> {t("settings.github.copy")}
              </button>
              <button
                className="btn"
                onClick={() => openUrl(code.verificationUri)}
              >
                <ExternalLink size={13} /> {t("settings.github.openGithub")}
              </button>
              <button className="btn" onClick={() => api.githubLoginCancel()}>
                {t("common.cancel")}
              </button>
              <div className="grow" />
              {waiting && (
                <span className="muted row">
                  <Loader2 size={13} className="spin" />{" "}
                  {t("settings.github.waiting")}
                </span>
              )}
            </div>
          </>
        ) : (
          <Rows>
            <Row
              title={t("settings.github.notSignedIn")}
              description={t("settings.github.notSignedInDesc")}
            >
              <button
                className="btn"
                disabled={checking || waiting}
                onClick={recheck}
              >
                {checking && <Loader2 size={13} className="spin" />}{" "}
                {t("settings.github.checkAgain")}
              </button>
              <button
                className="btn primary"
                disabled={waiting}
                onClick={connect}
              >
                {waiting ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Github size={14} />
                )}{" "}
                {t("settings.github.signIn")}
              </button>
            </Row>
          </Rows>
        )}
        {error && <div className="banner red">{error}</div>}
      </Section>
      <Section title={t("settings.github.sync")}>
        <Rows>
          <Row
            title={t("settings.github.syncEvery")}
            description={t("settings.github.syncEveryDesc")}
          >
            <Select
              width={130}
              value={String(settings.syncIntervalSecs)}
              options={[1, 2, 5, 15].map((m) => ({
                value: String(m * 60),
                label: t("settings.github.minutes", { count: m }),
              }))}
              onChange={(v) => saveSettings({ syncIntervalSecs: Number(v) })}
            />
          </Row>
        </Rows>
      </Section>
      <Note>{t("settings.github.note")}</Note>
    </Page>
  );
}

const WINDOW_LABELS: Record<UsageWindow["kind"], MessageKey> = {
  five_hour: "settings.claude.fiveHour",
  seven_day: "settings.claude.sevenDay",
};

function resetsIn(secs: number): string {
  const m = Math.max(0, Math.round((secs * 1000 - Date.now()) / 60000));
  if (m < 60) return translate("time.m", { m });
  const h = Math.floor(m / 60);
  return h < 24
    ? translate("time.hm", { h, m: m % 60 })
    : translate("time.dh", { d: Math.floor(h / 24), h: h % 24 });
}

function UsageBar({ w, loading }: { w: UsageWindow; loading?: boolean }) {
  const t = useT();
  const quilltex = w.totalTokens
    ? w.utilization * (w.quilltexTokens / w.totalTokens)
    : 0;
  const other = Math.max(0, w.utilization - quilltex);
  const limit = w.estimatedLimit;
  return (
    <div
      className={`usage-window${loading ? " loading" : ""}`}
      aria-busy={loading}
    >
      <div className="usage-head">
        <strong>{t(WINDOW_LABELS[w.kind])}</strong>
        <span className="muted">
          {t("settings.claude.resetsIn", { time: resetsIn(w.resetsAt) })}
        </span>
      </div>
      <SegmentedBar
        loading={loading}
        total={1}
        title={t("settings.claude.limitUsed", {
          pct: Math.round(w.utilization * 100),
        })}
        segments={[
          {
            key: "other",
            label: t("settings.claude.everythingElse"),
            value: other,
            display: compactNumber(w.totalTokens - w.quilltexTokens),
            color: "var(--text-quaternary)",
          },
          {
            key: "quilltex",
            label: "QuillTex",
            value: quilltex,
            display: compactNumber(w.quilltexTokens),
            color: "var(--accent)",
          },
        ]}
      />
      <div className="usage-numbers">
        <span>
          <T
            k="settings.claude.tokensUsed"
            params={{ pct: Math.round(w.utilization * 100) }}
            values={{
              tokens: <strong>{w.totalTokens.toLocaleString()}</strong>,
            }}
          />
        </span>
        <span>
          {limit ? (
            <T
              k="settings.claude.limitApprox"
              values={{ tokens: <strong>{limit.toLocaleString()}</strong> }}
            />
          ) : (
            t("settings.claude.limitUnknown")
          )}
        </span>
      </div>
    </div>
  );
}

const PLACEHOLDER_WINDOWS: UsageWindow[] = (
  ["five_hour", "seven_day"] as const
).map((kind) => ({
  kind,
  utilization: 0,
  resetsAt: 0,
  totalTokens: 0,
  quilltexTokens: 0,
  estimatedLimit: null,
}));

function UsageSection() {
  const t = useT();
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
    <Section
      title={t("settings.claude.usage")}
      actions={<RefreshButton loading={loading} onClick={() => load(true)} />}
    >
      <Rows>
        {windows
          ? windows.map((w) => <UsageBar key={w.kind} w={w} />)
          : !error &&
            PLACEHOLDER_WINDOWS.map((w) => (
              <UsageBar key={w.kind} w={w} loading />
            ))}
      </Rows>
      {error && <span className="hint muted">{error}</span>}
      {(windows || !error) && <Note>{t("settings.claude.usageNote")}</Note>}
    </Section>
  );
}

function ClaudeTab() {
  const t = useT();
  const { info, settings, saveSettings, refreshInfo, toast } = useApp();
  const [busy, setBusy] = useState(false);
  if (!settings) return null;
  const toggleMcp = async () => {
    setBusy(true);
    try {
      if (settings.mcpRegistered) await api.mcpUnregister();
      else await api.mcpRegister();
      useApp.setState({ settings: await api.getSettings() });
      toast(
        settings.mcpRegistered
          ? t("settings.claude.mcpRemoved")
          : t("settings.claude.mcpAdded"),
        "success",
      );
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title="Claude Code">
      <Section title={t("settings.claude.cli")}>
        <Rows>
          <Row
            title={t("settings.claude.cliTitle")}
            description={
              info?.claude ? (
                <T
                  k="settings.claude.found"
                  values={{
                    path: <span className="mono">{info.claude}</span>,
                  }}
                />
              ) : (
                t("settings.claude.notFound")
              )
            }
          >
            <StatusIcon ok={!!info?.claude} />
          </Row>
          <Row
            title={t("settings.claude.customPath")}
            description={t("settings.claude.customPathDesc")}
          >
            <input
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              className="input mono"
              style={{ width: 240 }}
              placeholder={t("settings.claude.autoDetect")}
              defaultValue={settings.claudePath}
              onBlur={async (e) => {
                await saveSettings({ claudePath: e.target.value.trim() });
                await refreshInfo();
              }}
            />
          </Row>
        </Rows>
      </Section>
      <Section title={t("settings.claude.integration")}>
        <Rows>
          <Row
            title={t("settings.claude.mcp")}
            description={t("settings.claude.mcpDesc")}
          >
            <button
              className={`switch${settings.mcpRegistered ? " on" : ""}`}
              disabled={busy || !info?.claude}
              onClick={toggleMcp}
            />
          </Row>
        </Rows>
      </Section>
      {info?.claude && <UsageSection />}
      <Note>{t("settings.claude.note")}</Note>
    </Page>
  );
}

function AboutSection() {
  const t = useT();
  const [version, setVersion] = useState("");
  const {
    phase,
    version: next,
    progress,
    error,
    check,
    install,
  } = useUpdater();
  useEffect(() => {
    void getVersion().then(setVersion);
  }, []);
  const busy = phase === "checking" || phase === "downloading";
  return (
    <Section title={t("settings.about.title")}>
      <Rows>
        <Row
          title={`QuillTex ${version}`}
          description={
            <>
              {phase === "checking" && t("settings.about.checking")}
              {phase === "downloading" &&
                (progress
                  ? t("settings.about.downloadingPct", {
                      version: next ?? "",
                      pct: Math.round(progress * 100),
                    })
                  : `${t("settings.about.downloading", { version: next ?? "" })}…`)}
              {phase === "available" &&
                t("settings.about.available", { version: next ?? "" })}
              {phase === "error" &&
                t("settings.about.error", { error: error ?? "" })}
              {phase === "idle" && t("settings.about.latest")}
            </>
          }
        >
          {phase === "available" ? (
            <button className="btn primary" onClick={() => void install()}>
              <ArrowDownToLine size={14} /> {t("settings.about.install")}
            </button>
          ) : (
            <button
              className="btn"
              disabled={busy}
              onClick={() => void check()}
            >
              {busy ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <RefreshCw size={14} />
              )}{" "}
              {t("settings.about.check")}
            </button>
          )}
        </Row>
      </Rows>
    </Section>
  );
}

const STORAGE_PARTS = [
  ["projects", "common.projects", "var(--accent)"],
  ["engine", "settings.storage.latex", "var(--green)"],
  ["system", "settings.storage.system", "var(--text-quaternary)"],
] as const satisfies readonly (readonly [string, MessageKey, string])[];

const EMPTY_USAGE: StorageUsage = {
  projects: 0,
  engine: 0,
  system: 0,
  total: 0,
};

function StorageOverview() {
  const t = useT();
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setUsage(await api.storageUsage());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const shown = usage ?? EMPTY_USAGE;
  return (
    <Section
      title={t("settings.storage.title")}
      actions={
        <RefreshButton
          loading={loading}
          title={t("settings.storage.recalculate")}
          onClick={() => load()}
        />
      }
    >
      <div className={`storage${usage ? "" : " loading"}`}>
        <div className="storage-total">
          <strong>{formatBytes(shown.total)}</strong>
          <span>{t("settings.storage.used")}</span>
        </div>
        <SegmentedBar
          loading={!usage}
          total={shown.total}
          segments={STORAGE_PARTS.map(([key, label, color]) => ({
            key,
            label: t(label),
            value: shown[key],
            display: formatBytes(shown[key]),
            color,
          }))}
        />
      </div>
      {error && <span className="hint muted">{error}</span>}
    </Section>
  );
}

function engineName(e: EngineEntry, t: TFunction): string {
  switch (e.id) {
    case "tectonic-cache":
      return t("settings.latex.cacheName");
    case "texlive":
      return t("settings.latex.texliveName");
    case "bundled":
      return t("settings.latex.bundledName");
    default:
      return e.name;
  }
}

function engineDetail(e: EngineEntry, t: TFunction): string {
  switch (e.id) {
    case "tectonic":
      return e.installed
        ? t("settings.latex.tectonicDetail")
        : t("settings.latex.tectonicMissing");
    case "tectonic-cache":
      return t("settings.latex.cacheDetail");
    case "texlive": {
      if (e.installed) {
        const version = /^TinyTeX (\S+?)\.\s/.exec(e.detail)?.[1];
        return version
          ? t("settings.latex.texliveInstalledVersion", { version })
          : t("settings.latex.texliveInstalled");
      }
      return e.detail.startsWith("Included")
        ? t("settings.latex.texliveBundled")
        : t("settings.latex.texliveDownload");
    }
    case "bundled":
      return t("settings.latex.bundledDetail");
  }
}

function EngineRow({
  engine,
  detail,
  action,
  busy,
  children,
}: {
  engine: EngineEntry;
  detail: string;
  action: React.ReactNode;
  busy: boolean;
  children?: React.ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const expandable = !!engine.path || !!children;
  return (
    <div className={`engine${open ? " open" : ""}`}>
      <div
        className={`engine-head${expandable ? " clickable" : ""}`}
        onClick={() => expandable && setOpen((v) => !v)}
      >
        <ChevronRight
          size={14}
          className="chevron"
          style={{ visibility: expandable ? "visible" : "hidden" }}
        />
        <div className="text">
          <strong>
            {engineName(engine, t)}
            {!engine.installed && engine.id !== "tectonic-cache" && (
              <span className="muted">{t("settings.latex.notInstalled")}</span>
            )}
          </strong>
          <span className="muted">{detail}</span>
        </div>
        <div
          className={`engine-end${busy ? " busy" : ""}${action ? " has-action" : ""}`}
        >
          <span className="size">
            {engine.installed ? formatBytes(engine.size) : "—"}
          </span>
          <div className="engine-action" onClick={(e) => e.stopPropagation()}>
            {busy ? <Loader2 size={14} className="spin" /> : action}
          </div>
        </div>
      </div>
      {open && (
        <div className="engine-body">
          {engine.path && (
            <span className="muted mono storage-path" title={engine.path}>
              {engine.path}
            </span>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

function PackageList({
  packages,
  busy,
  onRemove,
}: {
  packages: TexPackage[];
  busy: string | null;
  onRemove: (name: string) => void;
}) {
  const t = useT();
  return (
    <div className="package-list">
      {packages.map((p) => (
        <div className="package-row" key={p.name}>
          <div className="text">
            <strong>{p.name}</strong>
            <span className="muted">{p.description}</span>
          </div>
          <div
            className={`engine-end has-action${busy === `pkg:${p.name}` ? " busy" : ""}`}
          >
            <span className="size">{formatBytes(p.size)}</span>
            <div className="engine-action">
              <button
                className="btn sm icon ghost"
                title={t("settings.latex.removePackage", { name: p.name })}
                disabled={busy !== null}
                onClick={() => onRemove(p.name)}
              >
                {busy === `pkg:${p.name}` ? (
                  <Loader2 size={13} className="spin" />
                ) : (
                  <Trash2 size={13} />
                )}
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LatexTab() {
  const t = useT();
  const { toast, refreshInfo } = useApp();
  const [installed, setInstalled] = useState<Installed | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setInstalled(await api.installedComponents());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const run = async (
    id: string,
    action: () => Promise<unknown>,
    done: string,
  ) => {
    setBusy(id);
    try {
      await action();
      await refreshInfo();
      toast(done, "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
      setProgress(null);
      await load();
    }
  };

  const installTexlive = async () => {
    setProgress(t("settings.latex.starting"));
    const unlisten = await listen<string>("texlive-status", (e) =>
      setProgress(e.payload),
    );
    try {
      await run(
        "texlive",
        api.installTexlive,
        t("settings.latex.texliveReady"),
      );
    } finally {
      unlisten();
    }
  };

  const action = (e: EngineEntry) => {
    if (e.id === "texlive") {
      return e.installed ? (
        <button
          className="btn sm icon ghost"
          title={t("settings.latex.remove")}
          disabled={busy !== null}
          onClick={() =>
            run(
              "texlive",
              api.removeTexlive,
              t("settings.latex.texliveRemoved"),
            )
          }
        >
          <Trash2 size={13} />
        </button>
      ) : (
        <button
          className="btn sm icon ghost"
          title={t("settings.latex.install")}
          disabled={busy !== null}
          onClick={installTexlive}
        >
          <ArrowDownToLine size={13} />
        </button>
      );
    }
    if (e.id === "tectonic-cache" && e.installed) {
      return (
        <button
          className="btn sm icon ghost"
          title={t("settings.latex.clear")}
          disabled={busy !== null}
          onClick={() =>
            run(
              "tectonic-cache",
              api.clearTectonicCache,
              t("settings.latex.cacheCleared"),
            )
          }
        >
          <Trash2 size={13} />
        </button>
      );
    }
    return null;
  };

  const packages = installed?.packages ?? [];
  return (
    <Page
      title={t("settings.latex.title")}
      actions={<RefreshButton loading={loading} onClick={() => load()} />}
    >
      <Section title={t("settings.latex.installed")}>
        {installed ? (
          <Rows>
            {installed.engines.map((e) => (
              <EngineRow
                key={e.id}
                engine={e}
                detail={
                  busy === e.id && progress ? progress : engineDetail(e, t)
                }
                action={action(e)}
                busy={busy === e.id}
              >
                {e.id === "texlive" && e.installed && packages.length > 0 && (
                  <PackageList
                    packages={packages}
                    busy={busy}
                    onRemove={(name) =>
                      run(
                        `pkg:${name}`,
                        () => api.removeTexPackage(name),
                        t("settings.latex.packageRemoved", { name }),
                      )
                    }
                  />
                )}
              </EngineRow>
            ))}
          </Rows>
        ) : (
          !error && <Loader2 size={16} className="spin" />
        )}
        {error && <span className="hint muted">{error}</span>}
      </Section>
      <Note>{t("settings.latex.note")}</Note>
    </Page>
  );
}

function UninstallTab() {
  const t = useT();
  const { openDialog, setUi } = useApp();
  return (
    <Page title={t("settings.uninstall.title")}>
      <Section
        title={t("settings.uninstall.section")}
        description={t("settings.uninstall.desc")}
      >
        <div>
          <button
            className="btn danger"
            onClick={() => {
              setUi({ settings: null });
              openDialog({ kind: "uninstall" });
            }}
          >
            <Trash2 size={14} /> {t("settings.uninstall.button")}
          </button>
        </div>
      </Section>
    </Page>
  );
}
