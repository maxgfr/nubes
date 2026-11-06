//! The nubes engine for the web app. JSON in, JSON out: the snapshots are
//! plain objects on the TypeScript side (see `src/engine/index.ts`).

use wasm_bindgen::prelude::*;

/// Git blob id of `data`.
#[wasm_bindgen(js_name = gitBlobSha)]
pub fn git_blob_sha(data: &[u8]) -> String {
    nubes_core::git_blob_sha(data)
}

/// Incremental git blob hasher, for files read as a stream.
#[wasm_bindgen]
pub struct BlobHasher(Option<nubes_core::BlobHasher>);

#[wasm_bindgen]
impl BlobHasher {
    #[wasm_bindgen(constructor)]
    pub fn new(len: f64) -> BlobHasher {
        BlobHasher(Some(nubes_core::BlobHasher::new(len as u64)))
    }

    pub fn update(&mut self, chunk: &[u8]) -> Result<(), JsError> {
        self.0
            .as_mut()
            .ok_or_else(|| JsError::new("BlobHasher already finished"))?
            .update(chunk);
        Ok(())
    }

    pub fn finish(&mut self) -> Result<String, JsError> {
        let h = self
            .0
            .take()
            .ok_or_else(|| JsError::new("BlobHasher already finished"))?;
        h.try_finish()
            .ok_or_else(|| JsError::new("BlobHasher: length mismatch"))
    }
}

/// Plans a sync: `input` is a `PlanInput` as JSON, the result a `Plan`.
#[wasm_bindgen]
pub fn plan(input: &str) -> Result<String, JsError> {
    let input: nubes_core::PlanInput =
        serde_json::from_str(input).map_err(|e| JsError::new(&format!("plan input: {e}")))?;
    let out = nubes_core::plan(&input).map_err(|e| JsError::new(&e))?;
    serde_json::to_string(&out).map_err(|e| JsError::new(&e.to_string()))
}

/// The union of a pool's members: `input` is a `MergeInput` as JSON, the result a `View`.
#[wasm_bindgen(js_name = poolMerge)]
pub fn pool_merge(input: &str) -> Result<String, JsError> {
    let input: nubes_core::MergeInput =
        serde_json::from_str(input).map_err(|e| JsError::new(&format!("merge input: {e}")))?;
    serde_json::to_string(&nubes_core::merge(&input)).map_err(|e| JsError::new(&e.to_string()))
}

/// Which member each change goes to: `input` is a `PlaceInput` as JSON, the result a `Placement`.
#[wasm_bindgen(js_name = poolPlace)]
pub fn pool_place(input: &str) -> Result<String, JsError> {
    let input: nubes_core::PlaceInput =
        serde_json::from_str(input).map_err(|e| JsError::new(&format!("place input: {e}")))?;
    serde_json::to_string(&nubes_core::place(&input)).map_err(|e| JsError::new(&e.to_string()))
}

/// `.nubesignore` rules (plus the built-in defaults).
#[wasm_bindgen]
pub struct IgnoreMatcher(nubes_core::Matcher);

#[wasm_bindgen]
impl IgnoreMatcher {
    /// `text` is the content of a `.nubesignore` file (may be empty).
    #[wasm_bindgen(constructor)]
    pub fn new(text: &str) -> Result<IgnoreMatcher, JsError> {
        nubes_core::Matcher::from_file_text(text)
            .map(IgnoreMatcher)
            .map_err(|e| JsError::new(&e))
    }

    #[wasm_bindgen(js_name = isIgnored)]
    pub fn is_ignored(&self, path: &str) -> bool {
        self.0.is_ignored(path)
    }

    #[wasm_bindgen(js_name = isDirIgnored)]
    pub fn is_dir_ignored(&self, path: &str) -> bool {
        self.0.is_dir_ignored(path)
    }
}

#[wasm_bindgen(js_name = isSafePath)]
pub fn is_safe_path(path: &str) -> bool {
    nubes_core::is_safe_path(path)
}

#[wasm_bindgen(js_name = maxBlobSize)]
pub fn max_blob_size() -> f64 {
    nubes_core::GITHUB_MAX_BLOB as f64
}

#[wasm_bindgen(js_name = maxEncryptedBlobSize)]
pub fn max_encrypted_blob_size() -> f64 {
    nubes_core::GITHUB_MAX_ENCRYPTED as f64
}

#[wasm_bindgen(js_name = warnBlobSize)]
pub fn warn_blob_size() -> f64 {
    nubes_core::GITHUB_WARN_BLOB as f64
}

#[wasm_bindgen(js_name = formatVersion)]
pub fn format_version() -> u32 {
    nubes_core::FORMAT_VERSION
}
