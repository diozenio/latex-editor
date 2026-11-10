use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::state::AppState;

const API: &str = "https://openrouter.ai/api/v1";
pub const DEFAULT_MODEL: &str = "anthropic/claude-sonnet-5.5";
const MAX_STEPS: usize = 60;

/// A failure the UI can explain: `code` picks a translated message, `detail` is what the API said.
#[derive(Debug)]
pub struct AiError {
    pub code: &'static str,
    pub detail: String,
}

impl AiError {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self { code, detail: detail.into() }
    }
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.detail.is_empty() { write!(f, "{}", self.code) } else { write!(f, "{}", self.detail) }
    }
}

pub fn model(state: &AppState) -> String {
    Some(state.settings().openrouter_model).filter(|m| !m.trim().is_empty()).unwrap_or_else(|| DEFAULT_MODEL.into())
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(20)))
        .timeout_recv_response(Some(Duration::from_secs(180)))
        .build()
        .into()
}

fn network_error(e: impl std::fmt::Display) -> AiError {
    let detail = e.to_string();
    AiError::new(if detail.to_lowercase().contains("timeout") || detail.contains("timed out") { "timeout" } else { "network" }, detail)
}

fn api_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from))
        .unwrap_or_else(|| body.trim().chars().take(300).collect())
}

pub fn status_error(status: u16, detail: String) -> AiError {
    let lower = detail.to_lowercase();
    let code = if lower.contains("tool use") || lower.contains("support tool") {
        "noTools"
    } else if lower.contains("context length") || lower.contains("context window") || lower.contains("too many tokens") {
        "contextTooLong"
    } else {
        match status {
            401 => "invalidKey",
            402 => "noCredits",
            403 => "forbidden",
            404 => "modelNotFound",
            400 if lower.contains("not a valid model") => "modelNotFound",
            408 | 504 => "timeout",
            429 => "rateLimited",
            502 | 503 => "unavailable",
            400..=499 => "badRequest",
            _ => "server",
        }
    };
    AiError::new(code, detail)
}

/// Errors can also arrive inside a successful response, e.g. mid-stream when the provider fails.
fn body_error(err: &Value) -> AiError {
    let detail = err["message"].as_str().unwrap_or("unknown error").to_string();
    let status = err["code"].as_u64().or_else(|| err["code"].as_str().and_then(|c| c.parse().ok())).unwrap_or(500);
    status_error(status as u16, detail)
}

fn key_of(state: &AppState) -> Result<String, AiError> {
    Some(state.settings().openrouter_key.trim().to_string()).filter(|k| !k.is_empty()).ok_or_else(|| AiError::new("noKey", ""))
}

fn request(key: &str, path: &str, body: Option<&Value>) -> Result<ureq::Body, AiError> {
    let url = format!("{API}{path}");
    let auth = format!("Bearer {key}");
    let resp = match body {
        Some(b) => agent()
            .post(&url)
            .header("Authorization", &auth)
            .header("HTTP-Referer", "https://github.com/diozenio/latex-editor")
            .header("X-Title", "QuillTex")
            .header("Content-Type", "application/json")
            .send(b.to_string()),
        None => agent().get(&url).header("Authorization", &auth).call(),
    }
    .map_err(network_error)?;
    let status = resp.status().as_u16();
    let mut body = resp.into_body();
    if status >= 400 {
        let text = body.read_to_string().unwrap_or_default();
        return Err(status_error(status, api_message(&text)));
    }
    Ok(body)
}

fn get_json(key: &str, path: &str) -> Result<Value, AiError> {
    let text = request(key, path, None)?.read_to_string().map_err(network_error)?;
    serde_json::from_str(&text).map_err(|e| AiError::new("server", e.to_string()))
}

#[derive(Default)]
struct ToolCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct Turn {
    text: String,
    calls: Vec<ToolCall>,
}

fn stream(key: &str, body: &Value, cancel: &AtomicBool, on_text: &mut dyn FnMut(&str)) -> Result<Turn, AiError> {
    let reader = BufReader::new(request(key, "/chat/completions", Some(body))?.into_reader());
    read_stream(reader, cancel, on_text)
}

fn read_stream(reader: impl BufRead, cancel: &AtomicBool, on_text: &mut dyn FnMut(&str)) -> Result<Turn, AiError> {
    let mut turn = Turn::default();
    for line in reader.lines() {
        if cancel.load(Ordering::Relaxed) {
            return Err(AiError::new("cancelled", ""));
        }
        let line = line.map_err(network_error)?;
        let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
        if data == "[DONE]" {
            break;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else { continue };
        if chunk.get("error").is_some_and(|e| !e.is_null()) {
            return Err(body_error(&chunk["error"]));
        }
        let delta = &chunk["choices"][0]["delta"];
        if let Some(t) = delta["content"].as_str().filter(|t| !t.is_empty()) {
            turn.text.push_str(t);
            on_text(t);
        }
        for c in delta["tool_calls"].as_array().into_iter().flatten() {
            let i = c["index"].as_u64().map_or(turn.calls.len(), |i| i as usize);
            if turn.calls.len() <= i {
                turn.calls.resize_with(i + 1, ToolCall::default);
            }
            let call = &mut turn.calls[i];
            if let Some(id) = c["id"].as_str().filter(|id| !id.is_empty()) {
                call.id = id.into();
            }
            if let Some(n) = c["function"]["name"].as_str() {
                call.name.push_str(n);
            }
            if let Some(a) = c["function"]["arguments"].as_str() {
                call.arguments.push_str(a);
            }
        }
    }
    turn.calls.retain(|c| !c.name.is_empty());
    for (i, c) in turn.calls.iter_mut().enumerate() {
        if c.id.is_empty() {
            c.id = format!("call_{i}");
        }
    }
    Ok(turn)
}

fn tools() -> Vec<Value> {
    quilltex_mcp::tools::definitions()
        .into_iter()
        .map(|t| json!({ "type": "function", "function": { "name": t["name"], "description": t["description"], "parameters": t["inputSchema"] } }))
        .collect()
}

fn session_file(state: &AppState, id: &str) -> std::path::PathBuf {
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    state.config_dir.join("openrouter-sessions").join(format!("{safe}.json"))
}

fn save_session(state: &AppState, id: &str, history: &[Value]) {
    let p = session_file(state, id);
    let _ = std::fs::create_dir_all(p.parent().unwrap());
    let _ = std::fs::write(p, Value::Array(history.to_vec()).to_string());
}

/// Runs one chat turn: streams the reply and executes tool calls against the projects until the
/// model stops calling tools. Events mimic Claude Code's stream-json so the chat UI handles both.
pub fn run_chat(
    state: &AppState,
    message: &str,
    session_id: Option<String>,
    system: &str,
    cancel: &AtomicBool,
    emit: &dyn Fn(Value),
) -> Result<(), AiError> {
    let key = key_of(state)?;
    let model = model(state);
    let (id, mut history) = match session_id.filter(|s| s.starts_with("or-")) {
        Some(id) => {
            let h = std::fs::read_to_string(session_file(state, &id)).ok().and_then(|s| serde_json::from_str(&s).ok());
            (id, h.unwrap_or_default())
        }
        None => (format!("or-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()), Vec::new()),
    };
    emit(json!({ "type": "system", "session_id": id }));
    history.push(json!({ "role": "user", "content": message }));
    save_session(state, &id, &history);

    let ctx = quilltex_mcp::Ctx { ws: state.ws(), toolchain: state.toolchain.read().unwrap().clone() };
    let system = format!("{system}\n\n{}", quilltex_mcp::INSTRUCTIONS);
    let tools = tools();
    for _ in 0..MAX_STEPS {
        let mut messages = vec![json!({ "role": "system", "content": system })];
        messages.extend(history.iter().cloned());
        let body = json!({ "model": model, "messages": messages, "tools": tools, "stream": true });
        let turn = stream(&key, &body, cancel, &mut |t| {
            emit(json!({ "type": "stream_event", "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": t } } }))
        })?;
        let mut reply = json!({ "role": "assistant", "content": turn.text });
        if !turn.calls.is_empty() {
            reply["tool_calls"] = turn
                .calls
                .iter()
                .map(|c| json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": c.arguments } }))
                .collect();
        }
        history.push(reply);
        save_session(state, &id, &history);
        if turn.calls.is_empty() {
            return Ok(());
        }

        let parsed: Vec<Result<Value, String>> = turn
            .calls
            .iter()
            .map(|c| {
                if c.arguments.trim().is_empty() {
                    Ok(json!({}))
                } else {
                    serde_json::from_str(&c.arguments).map_err(|e| format!("invalid JSON arguments: {e}"))
                }
            })
            .collect();
        let blocks: Vec<Value> = turn
            .calls
            .iter()
            .zip(&parsed)
            .map(|(c, a)| json!({ "type": "tool_use", "id": c.id, "name": c.name, "input": a.clone().unwrap_or(json!({})) }))
            .collect();
        emit(json!({ "type": "assistant", "session_id": id, "message": { "content": blocks } }));
        for (c, args) in turn.calls.iter().zip(parsed) {
            if cancel.load(Ordering::Relaxed) {
                return Err(AiError::new("cancelled", ""));
            }
            let result = args.and_then(|a| quilltex_mcp::tools::call(&ctx, &c.name, &a));
            let (text, is_error) = match result {
                Ok(t) => (t, false),
                Err(e) => (e, true),
            };
            emit(json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": c.id, "content": text, "is_error": is_error }] } }));
            history.push(json!({ "role": "tool", "tool_call_id": c.id, "content": text }));
            save_session(state, &id, &history);
        }
    }
    Err(AiError::new("tooManySteps", ""))
}

/// One-shot completion without tools.
pub fn complete(state: &AppState, system: &str, prompt: &str) -> Result<String, AiError> {
    let key = key_of(state)?;
    let body = json!({
        "model": model(state),
        "messages": [{ "role": "system", "content": system }, { "role": "user", "content": prompt }],
    });
    let text = request(&key, "/chat/completions", Some(&body))?.read_to_string().map_err(network_error)?;
    let v: Value = serde_json::from_str(&text).map_err(|e| AiError::new("server", e.to_string()))?;
    if v.get("error").is_some_and(|e| !e.is_null()) {
        return Err(body_error(&v["error"]));
    }
    v["choices"][0]["message"]["content"].as_str().map(String::from).ok_or_else(|| AiError::new("badResponse", ""))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    label: String,
    usage: f64,
    limit: Option<f64>,
    limit_remaining: Option<f64>,
    is_free_tier: bool,
    credits: Option<f64>,
}

/// What AI commands reject with, so the UI can explain the failure.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiFailure {
    code: &'static str,
    detail: String,
}

impl From<String> for AiFailure {
    fn from(detail: String) -> Self {
        Self { code: "other", detail }
    }
}

impl From<&str> for AiFailure {
    fn from(detail: &str) -> Self {
        detail.to_string().into()
    }
}

impl From<AiError> for AiFailure {
    fn from(e: AiError) -> Self {
        Self { code: e.code, detail: e.detail }
    }
}

#[tauri::command]
pub async fn openrouter_key_info(key: String) -> Result<KeyInfo, AiFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = key.trim();
        if key.is_empty() {
            return Err(AiError::new("noKey", "").into());
        }
        let d = get_json(key, "/key")?["data"].clone();
        let credits = get_json(key, "/credits")
            .ok()
            .and_then(|c| Some(c["data"]["total_credits"].as_f64()? - c["data"]["total_usage"].as_f64()?));
        Ok(KeyInfo {
            label: d["label"].as_str().unwrap_or_default().into(),
            usage: d["usage"].as_f64().unwrap_or(0.0),
            limit: d["limit"].as_f64(),
            limit_remaining: d["limit_remaining"].as_f64(),
            is_free_tier: d["is_free_tier"].as_bool().unwrap_or(false),
            credits,
        })
    })
    .await
    .map_err(|e| AiFailure { code: "server", detail: e.to_string() })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_api_errors() {
        assert_eq!(status_error(401, "No auth credentials found".into()).code, "invalidKey");
        assert_eq!(status_error(402, "Insufficient credits".into()).code, "noCredits");
        assert_eq!(status_error(404, "No endpoints found that support tool use.".into()).code, "noTools");
        assert_eq!(status_error(400, "foo/bar is not a valid model ID".into()).code, "modelNotFound");
        assert_eq!(status_error(400, "This endpoint's maximum context length is 8192 tokens".into()).code, "contextTooLong");
        assert_eq!(status_error(429, "Rate limit exceeded".into()).code, "rateLimited");
        assert_eq!(body_error(&json!({ "code": 502, "message": "Provider returned error" })).code, "unavailable");
        assert_eq!(api_message(r#"{"error":{"code":401,"message":"User not found."}}"#), "User not found.");
    }

    #[test]
    fn reads_streamed_text_and_tool_calls() {
        let sse = r#": OPENROUTER PROCESSING
data: {"choices":[{"delta":{"content":"Let me "}}]}
data: {"choices":[{"delta":{"content":"check."}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"compile","arguments":"{\"pro"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ject\":\"Paper\"}"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"name":"list_projects","arguments":""}}]}}]}
data: [DONE]
"#;
        let mut text = String::new();
        let turn = read_stream(sse.as_bytes(), &AtomicBool::new(false), &mut |t| text.push_str(t)).unwrap();
        assert_eq!(text, "Let me check.");
        assert_eq!(turn.calls.len(), 2);
        assert_eq!((turn.calls[0].id.as_str(), turn.calls[0].arguments.as_str()), ("c1", r#"{"project":"Paper"}"#));
        assert_eq!((turn.calls[1].id.as_str(), turn.calls[1].name.as_str()), ("call_1", "list_projects"));

        let failed = "data: {\"error\":{\"code\":402,\"message\":\"Insufficient credits\"},\"choices\":[]}\n";
        assert_eq!(read_stream(failed.as_bytes(), &AtomicBool::new(false), &mut |_| {}).err().unwrap().code, "noCredits");
    }

    #[test]
    fn tools_use_the_openai_function_format() {
        let t = tools();
        assert!(t.iter().any(|t| t["function"]["name"] == "compile"));
        assert!(t.iter().all(|t| t["function"]["parameters"]["type"] == "object"));
    }
}
