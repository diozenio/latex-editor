//! `folio-mcp`: an MCP server (stdio, newline-delimited JSON-RPC) that lets
//! Claude Code manage Folio projects. Every path goes through
//! `folio_core::Workspace`, so nothing outside the projects folder is
//! reachable.
//!
//! Flags: --root <dir> --tectonic <bin> --tectonic-cache <dir>

mod tools;

use std::io::{BufRead, Write};
use std::path::PathBuf;

use serde_json::{json, Value};

use folio_core::{compile::Toolchain, Workspace};

pub struct Ctx {
    pub ws: Workspace,
    pub toolchain: Toolchain,
}

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let root = arg("--root").map(PathBuf::from).unwrap_or_else(Workspace::default_root);
    let ws = match Workspace::new(&root) {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("folio-mcp: cannot open {}: {e}", root.display());
            std::process::exit(1);
        }
    };
    // Default to the tectonic sidecar shipped next to this binary.
    let tectonic = arg("--tectonic").map(PathBuf::from).or_else(|| {
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        let name = if cfg!(windows) { "tectonic.exe" } else { "tectonic" };
        Some(dir.join(name)).filter(|p| p.is_file())
    });
    let ctx = Ctx {
        ws,
        toolchain: Toolchain {
            tectonic,
            tectonic_cache: arg("--tectonic-cache").map(PathBuf::from),
            system_tex_bin: folio_core::compile::detect_system_tex(),
        },
    };
    serve(&ctx, std::io::stdin().lock(), std::io::stdout().lock());
}

pub fn serve(ctx: &Ctx, input: impl BufRead, mut output: impl Write) {
    for line in input.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => handle(ctx, &msg),
            Err(e) => Some(error(Value::Null, -32700, &format!("parse error: {e}"))),
        };
        if let Some(r) = response {
            let _ = writeln!(output, "{r}");
            let _ = output.flush();
        }
    }
}

fn handle(ctx: &Ctx, msg: &Value) -> Option<Value> {
    let method = msg.get("method")?.as_str()?;
    // Notifications have no id and get no response.
    let id = msg.get("id")?.clone();
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    Some(match method {
        "initialize" => ok(id, json!({
            "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "folio", "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        })),
        "ping" => ok(id, json!({})),
        "tools/list" => ok(id, json!({ "tools": tools::definitions() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match tools::call(ctx, name, &args) {
                Ok(text) => ok(id, json!({ "content": [{ "type": "text", "text": text }] })),
                Err(e) => ok(id, json!({ "content": [{ "type": "text", "text": e }], "isError": true })),
            }
        }
        "resources/list" => ok(id, json!({ "resources": [] })),
        "prompts/list" => ok(id, json!({ "prompts": [] })),
        _ => error(id, -32601, &format!("method not found: {method}")),
    })
}

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

const INSTRUCTIONS: &str = "Folio is a local LaTeX editor. Each project is a folder of plain files. \
Use these tools to list, create, edit and compile projects. Paths are relative to the project root. \
Prefer edit_file for small changes and always compile after editing to check for errors. \
Never ask to access files outside the projects folder; it is not possible.";

#[cfg(test)]
mod tests {
    use super::*;

    fn run(ctx: &Ctx, lines: &[Value]) -> Vec<Value> {
        let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
        let mut out = Vec::new();
        serve(ctx, input.as_bytes(), &mut out);
        String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    fn call(id: u32, name: &str, args: Value) -> Value {
        json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":args}})
    }

    #[test]
    fn protocol_and_sandbox() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = Ctx { ws: Workspace::new(tmp.path().join("ws")).unwrap(), toolchain: Toolchain::default() };
        let out = run(&ctx, &[
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            call(3, "create_project", json!({"name":"Paper","template":"article"})),
            call(4, "write_file", json!({"project":"Paper","path":"sections/intro.tex","content":"Hello"})),
            call(5, "edit_file", json!({"project":"Paper","path":"sections/intro.tex","old_text":"Hello","new_text":"Hi"})),
            call(6, "read_file", json!({"project":"Paper","path":"sections/intro.tex"})),
            call(7, "read_file", json!({"project":"Paper","path":"../../etc/passwd"})),
            call(8, "write_file", json!({"project":"..","path":"x","content":"x"})),
            call(9, "list_projects", json!({})),
        ]);
        assert_eq!(out.len(), 9, "notification must not get a response");
        assert_eq!(out[0]["result"]["serverInfo"]["name"], "folio");
        assert!(out[1]["result"]["tools"].as_array().unwrap().len() > 10);
        assert_eq!(out[5]["result"]["content"][0]["text"], "Hi");
        assert_eq!(out[6]["result"]["isError"], true);
        assert_eq!(out[7]["result"]["isError"], true);
        assert!(out[8]["result"]["content"][0]["text"].as_str().unwrap().contains("Paper"));
        assert!(!tmp.path().join("x").exists());
    }
}
