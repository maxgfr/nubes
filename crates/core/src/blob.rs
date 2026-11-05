//! Git blob object ids: `sha1("blob <len>\0" + content)`, lowercase hex.
//!
//! This is the id GitHub reports for every file of a tree, so a local file
//! can be compared with its remote copy without downloading either.

use sha1::{Digest, Sha1};

/// The git blob id of `data`.
pub fn git_blob_sha(data: &[u8]) -> String {
    let mut h = BlobHasher::new(data.len() as u64);
    h.update(data);
    h.finish()
}

/// Incremental git blob hasher, for files read in chunks. The length must be
/// known up front because it is part of the header.
pub struct BlobHasher {
    inner: Sha1,
    expected: u64,
    seen: u64,
}

impl BlobHasher {
    pub fn new(len: u64) -> Self {
        let mut inner = Sha1::new();
        inner.update(format!("blob {len}\0").as_bytes());
        Self {
            inner,
            expected: len,
            seen: 0,
        }
    }

    pub fn update(&mut self, chunk: &[u8]) {
        self.seen += chunk.len() as u64;
        self.inner.update(chunk);
    }

    /// The hex id. Panics if fewer or more bytes than announced were hashed:
    /// that would silently produce an id that matches nothing.
    pub fn finish(self) -> String {
        let (expected, seen) = (self.expected, self.seen);
        self.try_finish()
            .unwrap_or_else(|| panic!("BlobHasher: announced {expected} bytes, hashed {seen}"))
    }

    /// The hex id, or `None` if the byte count does not match the announced length.
    pub fn try_finish(self) -> Option<String> {
        (self.seen == self.expected).then(|| hex(&self.inner.finalize()))
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_git_hash_object() {
        // `printf '' | git hash-object --stdin`
        assert_eq!(
            git_blob_sha(b""),
            "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
        );
        // `echo hello | git hash-object --stdin`
        assert_eq!(
            git_blob_sha(b"hello\n"),
            "ce013625030ba8dba906f756967f9e9ca394464a"
        );
    }

    #[test]
    fn chunked_equals_whole() {
        let data: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        let mut h = BlobHasher::new(data.len() as u64);
        for chunk in data.chunks(777) {
            h.update(chunk);
        }
        assert_eq!(h.finish(), git_blob_sha(&data));
    }

    #[test]
    #[should_panic]
    fn wrong_length_panics() {
        let mut h = BlobHasher::new(3);
        h.update(b"ab");
        let _ = h.finish();
    }
}
