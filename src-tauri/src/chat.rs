//! The side chat drives the user's installed Claude Code CLI in headless
//! mode. It only gets Folio's MCP tools: built-in file/shell tools are
//! disabled and it runs from a neutral folder, so it can touch projects but
//! nothing else (including this app's own source).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::commands::CmdResult;
use crate::state::AppState;

const DISALLOWED: &str = "Bash Edit Write MultiEdit NotebookEdit Read Glob Grep LS WebFetch WebSearch Task TodoWrite KillShell BashOutput Skill";

#[derive(Default)]
pub struct ChatProcesses(Mutex<HashMap<String, Arc<Mutex<Child>>>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatEvent {
    chat_id: String,
    event: Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatDone {
    chat_id: String,
    ok: bool,
    error: Option<String>,
}

pub(crate) fn claude_bin(state: &AppState) -> CmdResult<std::path::PathBuf> {
    crate::env::find_claude(&state.settings().claude_path)
        .ok_or_else(|| "Claude Code CLI not found. Install it from https://claude.com/claude-code and sign in.".into())
}

fn write_mcp_config(state: &AppState) -> CmdResult<std::path::PathBuf> {
    let cfg = json!({
        "mcpServers": {
            "folio": { "command": state.mcp_binary(), "args": state.mcp_args() }
        }
    });
    let path = state.config_dir.join("mcp.json");
    std::fs::write(&path, serde_json::to_string_pretty(&cfg).unwrap()).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub fn chat_send(
    app: AppHandle,
    state: State<AppState>,
    procs: State<ChatProcesses>,
    chat_id: String,
    message: String,
    session_id: Option<String>,
    context: String,
) -> CmdResult<()> {
    let bin = claude_bin(&state)?;
    if !state.mcp_binary().is_file() {
        return Err("folio-mcp sidecar is missing; run `npm run sidecars`.".into());
    }
    let mcp = write_mcp_config(&state)?;
    let cwd = state.config_dir.join("chat-workspace");
    std::fs::create_dir_all(&cwd).map_err(|e| e.to_string())?;

    let system = format!(
        "You are the assistant inside Folio, a local LaTeX editor. You can ONLY act through the `folio` MCP tools \
         (projects live in {}). Keep answers short. After editing .tex files, compile and fix errors you introduced. \
         Current context:\n{context}",
        state.ws().root().display()
    );
    let mut cmd = Command::new(&bin);
    cmd.args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"])
        .arg("--mcp-config")
        .arg(&mcp)
        .args(["--strict-mcp-config", "--disable-slash-commands", "--allowedTools", "mcp__folio", "--disallowedTools", DISALLOWED])
        .arg("--append-system-prompt")
        .arg(system);
    let model = state.settings().chat_model;
    if !model.is_empty() {
        cmd.args(["--model", &model]);
    }
    if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
        cmd.args(["--resume", &sid]);
    }
    cmd.current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to start claude: {e}"))?;
    // The prompt goes through stdin so it can never be mistaken for a flag.
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(message.as_bytes()).map_err(|e| e.to_string())?;
    }
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let child = Arc::new(Mutex::new(child));
    procs.0.lock().unwrap().insert(chat_id.clone(), child.clone());

    let stderr_buf = Arc::new(Mutex::new(String::new()));
    let sb = stderr_buf.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut b = sb.lock().unwrap();
            b.push_str(&line);
            b.push('\n');
        }
    });

    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                if let Some(state) = tauri::Manager::try_state::<AppState>(&app) {
                    crate::usage::remember(&state, &event);
                }
                let _ = app.emit("chat-event", ChatEvent { chat_id: chat_id.clone(), event });
            }
        }
        let status = child.lock().unwrap().wait();
        let ok = status.as_ref().map(|s| s.success()).unwrap_or(false);
        let err = stderr_buf.lock().unwrap().trim().to_string();
        let _ = app.emit(
            "chat-done",
            ChatDone { chat_id: chat_id.clone(), ok, error: (!ok && !err.is_empty()).then_some(err) },
        );
        if let Some(procs) = tauri::Manager::try_state::<ChatProcesses>(&app) {
            procs.0.lock().unwrap().remove(&chat_id);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn chat_cancel(procs: State<ChatProcesses>, chat_id: String) {
    if let Some(child) = procs.0.lock().unwrap().remove(&chat_id) {
        let _ = child.lock().unwrap().kill();
    }
}

fn chat_file(state: &AppState, key: &str) -> std::path::PathBuf {
    let safe: String = key.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    state.config_dir.join("chats").join(format!("{safe}.json"))
}

#[tauri::command]
pub fn chat_load(state: State<AppState>, key: String) -> Value {
    std::fs::read_to_string(chat_file(&state, &key))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub fn chat_save(state: State<AppState>, key: String, data: Value) -> CmdResult<()> {
    let p = chat_file(&state, &key);
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(p, data.to_string()).map_err(|e| e.to_string())
}

// ---------- Claude Code registration (for use from the terminal) ----------

fn run_claude(state: &AppState, args: &[String]) -> CmdResult<String> {
    let out = Command::new(claude_bin(state)?).args(args).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub fn register_mcp(state: &AppState) -> CmdResult<()> {
    let _ = unregister_mcp(state);
    let mut args: Vec<String> = ["mcp", "add", "folio", "--scope", "user", "--"].map(String::from).to_vec();
    args.push(state.mcp_binary().display().to_string());
    args.extend(state.mcp_args());
    run_claude(state, &args).map(|_| ())
}

pub fn unregister_mcp(state: &AppState) -> CmdResult<()> {
    run_claude(state, &["mcp", "remove", "folio", "--scope", "user"].map(String::from)).map(|_| ())
}

#[tauri::command]
pub fn mcp_register(state: State<AppState>) -> CmdResult<()> {
    register_mcp(&state)?;
    let mut s = state.settings();
    s.mcp_registered = true;
    state.save_settings(s).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mcp_unregister(state: State<AppState>) -> CmdResult<()> {
    let res = unregister_mcp(&state);
    let mut s = state.settings();
    s.mcp_registered = false;
    state.save_settings(s).map_err(|e| e.to_string())?;
    res
}
