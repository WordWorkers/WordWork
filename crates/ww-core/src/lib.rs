//! Word Work core. No UI or Tauri dependencies: everything here is testable
//! with `cargo test` and reusable from the desktop app or a future server.

pub mod ai;
pub mod convert;
pub mod error;
pub mod language;
pub mod storage;
pub mod text;
pub mod userdata;

pub use error::{Error, Result};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
