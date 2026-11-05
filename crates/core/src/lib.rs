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

/// Upper bound on the size of `plain` bytes once encrypted with age (an
/// encrypted folder, FORMAT.md version 2): a header (under 1 KiB for one
/// X25519 recipient), a 16-byte nonce, and a 16-byte tag per 64 KiB chunk.
pub const fn sealed_size_max(plain: u64) -> u64 {
    plain + 1024 + 16 + 16 * (plain / 65536 + 1)
}

/// The largest file an encrypted folder uploads: once encrypted, it still
/// fits in [`GITHUB_MAX_BLOB`].
pub const GITHUB_MAX_ENCRYPTED: u64 = GITHUB_MAX_BLOB - 32 * 1024;

/// Version of the on-repo format described in FORMAT.md.
pub const FORMAT_VERSION: u32 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_limit_fits_once_sealed() {
        assert!(sealed_size_max(GITHUB_MAX_ENCRYPTED) <= GITHUB_MAX_BLOB);
        // And not needlessly lower.
        assert!(sealed_size_max(GITHUB_MAX_ENCRYPTED + 8192) > GITHUB_MAX_BLOB);
    }
}
