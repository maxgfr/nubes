//! Replays `vectors.json`, which `bun test` also replays through the
//! WebAssembly build: both clients must agree on every case.

use nubes_core::{git_blob_sha, plan, Matcher, PlanInput};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors.json")).expect("vectors.json parses")
}

#[test]
fn blob_vectors() {
    for v in vectors()["blobs"].as_array().unwrap() {
        let text = v["text"].as_str().unwrap();
        assert_eq!(
            git_blob_sha(text.as_bytes()),
            v["sha"].as_str().unwrap(),
            "{text:?}"
        );
    }
}

#[test]
fn ignore_vectors() {
    for v in vectors()["ignore"].as_array().unwrap() {
        let patterns: Vec<String> = serde_json::from_value(v["patterns"].clone()).unwrap();
        let path = v["path"].as_str().unwrap();
        let m = Matcher::new(&patterns).unwrap();
        assert_eq!(
            m.is_ignored(path),
            v["ignored"].as_bool().unwrap(),
            "{patterns:?} {path}"
        );
    }
}

#[test]
fn plan_vectors() {
    for v in vectors()["plans"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let input: PlanInput = serde_json::from_value(v["input"].clone()).unwrap();
        let out = plan(&input).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            serde_json::to_value(&out.actions).unwrap(),
            v["actions"],
            "{name}: actions"
        );
        assert_eq!(
            serde_json::to_value(&out.next_base).unwrap(),
            v["nextBase"],
            "{name}: nextBase"
        );
    }
}
