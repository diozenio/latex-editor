use serde_json::{json, Value};

use folio_core::{archive, compile, files, git, project, templates};

use crate::Ctx;

type R = Result<String, String>;

fn s<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| format!("missing argument: {key}"))
}

fn opt<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn to_json<T: serde::Serialize>(v: &T) -> R {
    serde_json::to_string_pretty(v).map_err(|e| e.to_string())
}

pub fn call(ctx: &Ctx, name: &str, a: &Value) -> R {
    let ws = &ctx.ws;
    let e = |e: folio_core::Error| e.to_string();
    match name {
        "list_projects" => to_json(&project::list(ws).map_err(e)?),
        "create_project" => {
            let tpl = opt(a, "template").unwrap_or("blank");
            let p = project::create(ws, s(a, "name")?, tpl).map_err(e)?;
            Ok(format!("Created project {} at {}", p.name, p.path))
        }
        "list_templates" => to_json(&templates::TEMPLATES),
        "import_zip" => {
            let path = std::path::Path::new(s(a, "zip_path")?);
            let name = match opt(a, "name") {
                Some(n) => n.to_string(),
                None => project::unique_name(ws, &path.file_stem().unwrap_or_default().to_string_lossy()),
            };
            let p = archive::import_zip(ws, path, &name).map_err(e)?;
            Ok(format!("Imported into project {}", p.name))
        }
        "export_zip" => {
            let dest = std::path::Path::new(s(a, "dest_path")?);
            archive::export_zip(ws, s(a, "project")?, dest, a.get("include_git").and_then(Value::as_bool).unwrap_or(false))
                .map_err(e)?;
            Ok(format!("Exported to {}", dest.display()))
        }
        "rename_project" => {
            project::rename(ws, s(a, "project")?, s(a, "new_name")?).map_err(e)?;
            Ok("Renamed".into())
        }
        "delete_project" => {
            project::delete(ws, s(a, "project")?).map_err(e)?;
            Ok("Moved the project to the trash".into())
        }
        "get_project_settings" => to_json(&project::read_meta(ws, s(a, "project")?).map_err(e)?),
        "set_main_file" => {
            let p = s(a, "project")?;
            let path = s(a, "path")?;
            if !ws.resolve(p, path).map_err(e)?.is_file() {
                return Err(format!("{path} does not exist"));
            }
            let mut meta = project::read_meta(ws, p).map_err(e)?;
            meta.main_file = path.to_string();
            project::write_meta(ws, p, &meta).map_err(e)?;
            Ok(format!("Main file set to {path}"))
        }
        "list_files" => {
            let mut out = String::new();
            fn walk(nodes: &[files::FileNode], out: &mut String) {
                for n in nodes {
                    if n.is_dir {
                        out.push_str(&format!("{}/\n", n.path));
                        walk(n.children.as_deref().unwrap_or_default(), out);
                    } else {
                        out.push_str(&format!("{} ({} bytes)\n", n.path, n.size));
                    }
                }
            }
            walk(&files::tree(ws, s(a, "project")?).map_err(e)?, &mut out);
            Ok(if out.is_empty() { "(empty project)".into() } else { out })
        }
        "read_file" => files::read_text(ws, s(a, "project")?, s(a, "path")?).map_err(e),
        "write_file" => {
            files::write_text(ws, s(a, "project")?, s(a, "path")?, s(a, "content")?).map_err(e)?;
            Ok(format!("Wrote {}", s(a, "path")?))
        }
        "edit_file" => {
            files::edit_text(ws, s(a, "project")?, s(a, "path")?, s(a, "old_text")?, s(a, "new_text")?).map_err(e)?;
            Ok(format!("Edited {}", s(a, "path")?))
        }
        "create_folder" => {
            files::create_dir(ws, s(a, "project")?, s(a, "path")?).map_err(e)?;
            Ok("Created".into())
        }
        "move_path" => {
            files::rename(ws, s(a, "project")?, s(a, "from")?, s(a, "to")?).map_err(e)?;
            Ok("Moved".into())
        }
        "delete_path" => {
            files::delete(ws, s(a, "project")?, s(a, "path")?).map_err(e)?;
            Ok("Moved to trash".into())
        }
        "compile" => {
            let r = compile::compile(ws, s(a, "project")?, &ctx.toolchain).map_err(e)?;
            let mut out = format!(
                "{} in {} ms. PDF: {}\n",
                if r.ok { "Compiled successfully" } else { "Compilation FAILED" },
                r.duration_ms,
                r.pdf.as_deref().unwrap_or("none")
            );
            for d in r.diagnostics.iter().filter(|d| d.severity != compile::Severity::Info).take(30) {
                out.push_str(&format!(
                    "- [{:?}] {}{}: {}\n",
                    d.severity,
                    d.file.as_deref().unwrap_or(""),
                    d.line.map(|l| format!(":{l}")).unwrap_or_default(),
                    d.message
                ));
            }
            Ok(out)
        }
        "get_compile_log" => {
            let p = s(a, "project")?;
            let meta = project::read_meta(ws, p).map_err(e)?;
            let stem = std::path::Path::new(&meta.main_file).file_stem().unwrap_or_default().to_string_lossy().to_string();
            let log = ws.project_dir(p).map_err(e)?.join(project::BUILD_DIR).join(format!("{stem}.log"));
            let text = std::fs::read_to_string(log).map_err(|_| "no log yet; compile first".to_string())?;
            // The tail is where errors are.
            let tail: Vec<&str> = text.lines().rev().take(200).collect();
            Ok(tail.into_iter().rev().collect::<Vec<_>>().join("\n"))
        }
        "git_status" => to_json(&git::status(ws, s(a, "project")?).map_err(e)?),
        "git_init" => {
            git::init(ws, s(a, "project")?, "", "").map_err(e)?;
            Ok("Initialized git repository".into())
        }
        "git_commit" => {
            let p = s(a, "project")?;
            git::stage_all(ws, p).map_err(e)?;
            let id = git::commit(ws, p, s(a, "message")?).map_err(e)?;
            Ok(format!("Committed {}", &id[..7]))
        }
        "git_log" => to_json(&git::log(ws, s(a, "project")?, 30).map_err(e)?),
        "git_diff" => git::diff_file(ws, s(a, "project")?, s(a, "path")?).map_err(e),
        "git_branches" => to_json(&git::branches(ws, s(a, "project")?).map_err(e)?),
        "git_create_branch" => {
            git::create_branch(ws, s(a, "project")?, s(a, "name")?, true).map_err(e)?;
            Ok("Created and switched".into())
        }
        "git_checkout" => {
            git::checkout_branch(ws, s(a, "project")?, s(a, "name")?).map_err(e)?;
            Ok("Switched".into())
        }
        "git_merge" => to_json(&git::merge(ws, s(a, "project")?, s(a, "from")?).map_err(e)?),
        "git_pull" => to_json(&git::pull(ws, s(a, "project")?).map_err(e)?),
        "git_push" => {
            git::push(ws, s(a, "project")?).map_err(e)?;
            Ok("Pushed".into())
        }
        _ => Err(format!("unknown tool: {name}")),
    }
}

fn tool(name: &str, description: &str, props: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": props, "required": required },
    })
}

pub fn definitions() -> Vec<Value> {
    let p = json!({ "type": "string", "description": "Project name (folder name)" });
    let path = json!({ "type": "string", "description": "Path relative to the project root, forward slashes" });
    vec![
        tool("list_projects", "List all Folio projects with their main file and last modification.", json!({}), &[]),
        tool("list_templates", "List available project templates.", json!({}), &[]),
        tool("create_project", "Create a new project from a template (blank, article, report, beamer, letter, cv).",
            json!({ "name": { "type": "string" }, "template": { "type": "string" } }), &["name"]),
        tool("import_zip", "Create a project from a .zip file on disk.",
            json!({ "zip_path": { "type": "string" }, "name": { "type": "string" } }), &["zip_path"]),
        tool("export_zip", "Export a project as a .zip to dest_path.",
            json!({ "project": p, "dest_path": { "type": "string" }, "include_git": { "type": "boolean" } }), &["project", "dest_path"]),
        tool("rename_project", "Rename a project.", json!({ "project": p, "new_name": { "type": "string" } }), &["project", "new_name"]),
        tool("delete_project", "Move a project to the OS trash (recoverable).", json!({ "project": p }), &["project"]),
        tool("get_project_settings", "Show project settings (main file, engine).", json!({ "project": p }), &["project"]),
        tool("set_main_file", "Set the root .tex file that gets compiled.", json!({ "project": p, "path": path }), &["project", "path"]),
        tool("list_files", "List every file in a project.", json!({ "project": p }), &["project"]),
        tool("read_file", "Read a text file.", json!({ "project": p, "path": path }), &["project", "path"]),
        tool("write_file", "Create or overwrite a text file (parent folders are created).",
            json!({ "project": p, "path": path, "content": { "type": "string" } }), &["project", "path", "content"]),
        tool("edit_file", "Replace exactly one occurrence of old_text with new_text in a file.",
            json!({ "project": p, "path": path, "old_text": { "type": "string" }, "new_text": { "type": "string" } }),
            &["project", "path", "old_text", "new_text"]),
        tool("create_folder", "Create a folder.", json!({ "project": p, "path": path }), &["project", "path"]),
        tool("move_path", "Move or rename a file or folder inside a project.",
            json!({ "project": p, "from": path, "to": path }), &["project", "from", "to"]),
        tool("delete_path", "Move a file or folder to the OS trash.", json!({ "project": p, "path": path }), &["project", "path"]),
        tool("compile", "Compile the project to PDF and return errors and warnings.", json!({ "project": p }), &["project"]),
        tool("get_compile_log", "Return the tail of the last TeX log.", json!({ "project": p }), &["project"]),
        tool("git_status", "Branch, ahead/behind origin, and changed files.", json!({ "project": p }), &["project"]),
        tool("git_init", "Initialize a git repository in the project.", json!({ "project": p }), &["project"]),
        tool("git_commit", "Stage all changes and commit.", json!({ "project": p, "message": { "type": "string" } }), &["project", "message"]),
        tool("git_log", "Recent commits.", json!({ "project": p }), &["project"]),
        tool("git_diff", "Diff of a file against HEAD.", json!({ "project": p, "path": path }), &["project", "path"]),
        tool("git_branches", "List local and remote branches.", json!({ "project": p }), &["project"]),
        tool("git_create_branch", "Create a branch from HEAD and switch to it.", json!({ "project": p, "name": { "type": "string" } }), &["project", "name"]),
        tool("git_checkout", "Switch to a branch (local or origin/<name>).", json!({ "project": p, "name": { "type": "string" } }), &["project", "name"]),
        tool("git_merge", "Merge a branch into the current one. Reports conflicts.", json!({ "project": p, "from": { "type": "string" } }), &["project", "from"]),
        tool("git_pull", "Fetch and merge from origin.", json!({ "project": p }), &["project"]),
        tool("git_push", "Push the current branch to origin.", json!({ "project": p }), &["project"]),
    ]
}
