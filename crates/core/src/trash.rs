//! Moving things to the OS trash, silently.

use std::path::Path;

/// Moves `path` to the OS trash. On macOS the `trash` crate defaults to asking
/// Finder, which plays the trash sound; NSFileManager does the same move quietly.
pub fn delete(path: &Path) -> Result<(), ::trash::Error> {
    #[allow(unused_mut)]
    let mut ctx = ::trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use ::trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete(path)
}
