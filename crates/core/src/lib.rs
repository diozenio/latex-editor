//! Folio core: everything that touches disk lives here so the desktop app and
//! the MCP server share the exact same rules (and the same sandbox).

pub mod archive;
pub mod compile;
pub mod error;
pub mod files;
pub mod gh;
pub mod git;
pub mod paths;
pub mod project;
pub mod synctex;
pub mod templates;
pub mod trash;

pub use error::{Error, Result};
pub use paths::Workspace;
