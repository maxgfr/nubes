//! nubes-core: the part of nubes that the CLI and the web app share.
//!
//! Everything here is pure (no file system, no network, no clock): the CLI
//! links it natively, the web app loads it as WebAssembly, and both replay
//! the same `tests/vectors.json`. Given the same three snapshots, they plan
//! the same actions.

pub mod blob;
mod glob;
pub mod ignore;
pub mod path;
pub mod plan;

pub use blob::{git_blob_sha, BlobHasher};
pub use ignore::Matcher;
pub use path::{conflict_name, is_safe_path};
pub use plan::{plan, Action, Direction, Entry, Plan, PlanInput, SkipReason, Snapshot, Summary};

/// The largest file GitHub accepts in a git blob (100 MiB).
pub const GITHUB_MAX_BLOB: u64 = 100 * 1024 * 1024;

/// GitHub warns about files past this size (50 MiB).
pub const GITHUB_WARN_BLOB: u64 = 50 * 1024 * 1024;

/// Version of the on-repo format described in FORMAT.md.
pub const FORMAT_VERSION: u32 = 1;
