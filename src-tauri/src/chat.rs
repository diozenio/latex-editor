use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::commands::CmdResult;
use crate::state::AppState;

const DISALLOWED: &str = "Bash Edit Write MultiEdit NotebookEdit Read Glob Grep LS WebFetch WebSearch Task TodoWrite KillShell BashOutput Skill";

#[derive(Default)]
pub struct ChatProcesses(Mutex<HashMap<String, Arc<Mutex<Child>>>>);

/// Cancel flags of chats running in-process (OpenRouter).
#[derive(Default)]
pub struct ChatCancels(Mutex<HashMap<String, Arc<AtomicBool>>>);

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
    code: Option<String>,
}

pub(crate) fn claude_bin(state: &AppState) -> CmdResult<std::path::PathBuf> {
    crate::env::find_claude(&state.settings().claude_path)
        .ok_or_else(|| "Claude Code CLI not found. Install it from https://claude.com/claude-code and sign in.".into())
}

fn write_mcp_config(state: &AppState) -> CmdResult<std::path::PathBuf> {
    let cfg = json!({
        "mcpServers": {
            "quilltex": { "command": state.mcp_binary(), "args": state.mcp_args() }
        }
    });
    let path = state.config_dir.join("mcp.json");
    std::fs::write(&path, serde_json::to_string_pretty(&cfg).unwrap()).map_err(|e| e.to_string())?;
    Ok(path)
}

fn system_prompt(state: &AppState, context: &str) -> String {
    format!(
        "You are the assistant inside QuillTex, a local LaTeX and document editor. You can ONLY act through the `quilltex` tools \
         (projects live in {}). Keep answers short. After editing .tex files, compile and fix errors you introduced. \
         Projects whose main file is .md are rich-text documents for people who do not use LaTeX: keep them plain Markdown \
         (headings, **bold**, *italic*, <u>underline</u>, ~~strike~~, <span style=\"color: #c62828\">colored text</span> \
         with a #hex or common color name, lists, `- [ ]` checklists, pipe tables, > quotes, links, \
         images from the project like ![caption](images/x.png)), never add LaTeX or any other HTML to them, and leave the front \
         matter keys (title, author, date, font, fontSize, spacing, margins, paper, numbered) in place. \
         Current context:\n{context}",
        state.ws().root().display()
    )
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
    if state.settings().ai_provider == "openrouter" {
        return send_openrouter(app, chat_id, message, session_id, context);
    }
    send_claude(app, &state, &procs, chat_id, message, session_id, context)
}

fn send_openrouter(
    app: AppHandle,
    chat_id: String,
    message: String,
    session_id: Option<String>,
    context: String,
) -> CmdResult<()> {
    let cancel = Arc::new(AtomicBool::new(false));
    tauri::Manager::state::<ChatCancels>(&app).0.lock().unwrap().insert(chat_id.clone(), cancel.clone());
    std::thread::spawn(move || {
        let state = tauri::Manager::state::<AppState>(&app);
        let system = system_prompt(&state, &context);
        let emit = |event: Value| {
            let _ = app.emit("chat-event", ChatEvent { chat_id: chat_id.clone(), event });
        };
        let res = crate::openrouter::run_chat(&state, &message, session_id, &system, &cancel, &emit);
        let done = match res {
            Ok(()) => ChatDone { chat_id: chat_id.clone(), ok: true, error: None, code: None },
            Err(e) if e.code == "cancelled" => ChatDone { chat_id: chat_id.clone(), ok: false, error: None, code: None },
            Err(e) => ChatDone { chat_id: chat_id.clone(), ok: false, error: Some(e.to_string()), code: Some(e.code.into()) },
        };
        let _ = app.emit("chat-done", done);
        if let Some(cancels) = tauri::Manager::try_state::<ChatCancels>(&app) {
            cancels.0.lock().unwrap().remove(&chat_id);
        }
    });
    Ok(())
}

fn send_claude(
    app: AppHandle,
    state: &AppState,
    procs: &ChatProcesses,
    chat_id: String,
    message: String,
    session_id: Option<String>,
    context: String,
) -> CmdResult<()> {
    let bin = claude_bin(state)?;
    if !state.mcp_binary().is_file() {
        return Err("quilltex-mcp sidecar is missing; run `npm run sidecars`.".into());
    }
    let mcp = write_mcp_config(state)?;
    let cwd = state.config_dir.join("chat-workspace");
    std::fs::create_dir_all(&cwd).map_err(|e| e.to_string())?;
    let system = system_prompt(state, &context);
    let mut cmd = Command::new(&bin);
    cmd.args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"])
        .arg("--mcp-config")
        .arg(&mcp)
        .args(["--strict-mcp-config", "--disable-slash-commands", "--allowedTools", "mcp__quilltex", "--disallowedTools", DISALLOWED])
        .arg("--append-system-prompt")
        .arg(system);
    let model = state.settings().chat_model;
    if !model.is_empty() {
        cmd.args(["--model", &model]);
    }
    // Sessions started with OpenRouter ("or-…") are unknown to Claude Code.
    if let Some(sid) = session_id.filter(|s| !s.is_empty() && !s.starts_with("or-")) {
        cmd.args(["--resume", &sid]);
    }
    cmd.current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to start claude: {e}"))?;
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
            ChatDone { chat_id: chat_id.clone(), ok, error: (!ok && !err.is_empty()).then_some(err), code: None },
        );
        if let Some(procs) = tauri::Manager::try_state::<ChatProcesses>(&app) {
            procs.0.lock().unwrap().remove(&chat_id);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn chat_cancel(procs: State<ChatProcesses>, cancels: State<ChatCancels>, chat_id: String) {
    if let Some(child) = procs.0.lock().unwrap().remove(&chat_id) {
        let _ = child.lock().unwrap().kill();
    }
    if let Some(cancel) = cancels.0.lock().unwrap().get(&chat_id) {
        cancel.store(true, Ordering::Relaxed);
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

/// One-shot answer from Claude Code without tools.
pub fn claude_complete(state: &AppState, system: &str, prompt: &str) -> CmdResult<String> {
    let cwd = state.config_dir.join("chat-workspace");
    std::fs::create_dir_all(&cwd).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(claude_bin(state)?);
    cmd.args(["-p", "--output-format", "json", "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config", "--tools", ""])
        .arg("--append-system-prompt")
        .arg(system);
    let model = state.settings().chat_model;
    if !model.is_empty() {
        cmd.args(["--model", &model]);
    }
    cmd.current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to start claude: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
    let result = v["result"].as_str().unwrap_or_default().to_string();
    if !out.status.success() || v["is_error"].as_bool() == Some(true) {
        let err = if result.is_empty() { String::from_utf8_lossy(&out.stderr).trim().to_string() } else { result };
        return Err(if err.is_empty() { "Claude Code failed".into() } else { err });
    }
    Ok(result)
}

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
    let mut args: Vec<String> = ["mcp", "add", "quilltex", "--scope", "user", "--"].map(String::from).to_vec();
    args.push(state.mcp_binary().display().to_string());
    args.extend(state.mcp_args());
    run_claude(state, &args).map(|_| ())
}

pub fn unregister_mcp(state: &AppState) -> CmdResult<()> {
    run_claude(state, &["mcp", "remove", "quilltex", "--scope", "user"].map(String::from)).map(|_| ())
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
