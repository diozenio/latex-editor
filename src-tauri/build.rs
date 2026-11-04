fn main() {
    for dir in ["resources/tectonic-cache", "resources/texlive"] {
        std::fs::create_dir_all(dir).expect("create resource folder");
    }
    tauri_build::build()
}
