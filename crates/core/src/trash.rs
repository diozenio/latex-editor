use std::path::Path;

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
