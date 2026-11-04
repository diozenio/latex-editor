fn main() {
    // Bundled engine files (see scripts/fetch-sidecars.mjs). Tauri fails on a
    // missing resource folder, so they exist even before the script has run.
    for dir in ["resources/tectonic-cache", "resources/texlive"] {
        std::fs::create_dir_all(dir).expect("create resource folder");
    }
    tauri_build::build()
}
