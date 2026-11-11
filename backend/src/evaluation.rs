//! Fixed, declared evaluation protocol. Compatibility is not proof of scientific validity.
use anyhow::{bail, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn validate(value: &Value) -> Result<()> {
    let fields = [
        "dataset",
        "dataset_version",
        "split",
        "evaluator_sha256",
        "metric",
        "direction",
        "seed",
    ];
    let Some(object) = value.as_object() else {
        bail!("INVALID_EVALUATION_SPEC");
    };
    if object.len() != fields.len() || object.keys().any(|k| !fields.contains(&k.as_str())) {
        bail!("INVALID_EVALUATION_SPEC");
    }
    for field in ["dataset", "dataset_version", "split", "metric"] {
        if !value[field].as_str().is_some_and(|s| {
            !s.trim().is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)
        }) {
            bail!("INVALID_EVALUATION_SPEC");
        }
    }
    if !value["evaluator_sha256"].as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) || !matches!(value["direction"].as_str(), Some("maximize" | "minimize"))
        || value["seed"].as_u64().is_none()
    {
        bail!("INVALID_EVALUATION_SPEC");
    }
    Ok(())
}

pub fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

pub fn final_metric(run: &Value, metrics: &[Value]) -> Result<Value> {
    let spec = &run["evaluation"];
    validate(spec)?;
    let expected_hash = hash(spec);
    if run["evaluation_hash"] != expected_hash {
        bail!("INVALID_EVALUATION_HASH");
    }
    let matching: Vec<_> = metrics
        .iter()
        .filter(|m| m["stage"] == "evaluate" && m["metric"] == spec["metric"])
        .collect();
    if matching.is_empty() {
        bail!("EVALUATION_METRIC_MISSING");
    }
    if matching.iter().any(|m| {
        m["evaluation_hash"] != expected_hash
            || m["run_id"] != run["id"]
            || !m["value"].as_f64().is_some_and(f64::is_finite)
            || m["step"].as_u64().is_none()
    }) {
        bail!("EVALUATION_EVIDENCE_MISMATCH");
    }
    let step = matching
        .iter()
        .filter_map(|m| m["step"].as_u64())
        .max()
        .unwrap();
    let final_records: Vec<_> = matching.into_iter().filter(|m| m["step"] == step).collect();
    if final_records.len() != 1 {
        bail!("AMBIGUOUS_FINAL_METRIC");
    }
    Ok(final_records[0].clone())
}

pub fn compare(
    baseline: &Value,
    candidate: &Value,
    baseline_metrics: &[Value],
    candidate_metrics: &[Value],
) -> Value {
    let result = (|| -> Result<Value> {
        if baseline["id"] == candidate["id"] {
            bail!("SELECT_DISTINCT_RUNS");
        }
        if baseline["evaluation"].is_null() || candidate["evaluation"].is_null() {
            bail!("EVALUATION_SPEC_MISSING");
        }
        if baseline["evaluation"] != candidate["evaluation"] {
            bail!("EVALUATION_PROTOCOL_MISMATCH");
        }
        if baseline["target"] != candidate["target"] {
            bail!("EXECUTION_TARGET_MISMATCH");
        }
        for run in [baseline, candidate] {
            if run["state"] != "succeeded" || run["evidence_state"] != "ready" {
                bail!("RUN_EVIDENCE_NOT_READY");
            }
        }
        let b = final_metric(baseline, baseline_metrics)?;
        let c = final_metric(candidate, candidate_metrics)?;
        let delta = c["value"].as_f64().unwrap() - b["value"].as_f64().unwrap();
        if !delta.is_finite() {
            bail!("NONFINITE_METRIC_DELTA");
        }
        let improvement = if baseline["evaluation"]["direction"] == "minimize" {
            -delta
        } else {
            delta
        };
        Ok(
            json!({"comparable":true,"evaluation":baseline["evaluation"],"evaluation_hash":baseline["evaluation_hash"],"baseline_metric":b,"candidate_metric":c,"delta":delta,"improvement":improvement,"outcome":if improvement>0.0{"improved"}else if improvement<0.0{"regressed"}else{"tied"}}),
        )
    })();
    let mut value = result.unwrap_or_else(|e| json!({"comparable":false,"reason":e.to_string()}));
    value["baseline_run_id"] = baseline["id"].clone();
    value["candidate_run_id"] = candidate["id"].clone();
    value["baseline_commit"] = baseline["snapshot"]["commit"].clone();
    value["candidate_commit"] = candidate["snapshot"]["commit"].clone();
    value["limitation"] = json!("Single-run comparison of declared matching protocols; not statistical significance or independent verification of dataset/evaluator execution. No automatic promotion.");
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn comparison_requires_matching_protocol_and_unambiguous_evidence() {
        let spec = json!({"dataset":"synthetic","dataset_version":"v1","split":"validation","evaluator_sha256":"a".repeat(64),"metric":"loss","direction":"minimize","seed":41});
        let mut b = json!({"id":"b","evaluation":spec,"evaluation_hash":hash(&spec),"state":"succeeded","evidence_state":"ready","target":"local"});
        let mut c = b.clone();
        c["id"] = json!("c");
        let bm = json!({"run_id":"b","evaluation_hash":hash(&spec),"stage":"evaluate","metric":"loss","step":5,"value":0.5});
        let mut cm = bm.clone();
        cm["run_id"] = json!("c");
        cm["value"] = json!(0.25);
        assert_eq!(
            compare(&b, &c, std::slice::from_ref(&bm), std::slice::from_ref(&cm))["improvement"],
            0.25
        );
        assert_eq!(
            compare(&b, &c, std::slice::from_ref(&bm), &[cm.clone(), cm.clone()])["reason"],
            "AMBIGUOUS_FINAL_METRIC"
        );
        cm["evaluation_hash"] = json!("wrong");
        assert_eq!(
            compare(&b, &c, std::slice::from_ref(&bm), &[cm])["reason"],
            "EVALUATION_EVIDENCE_MISMATCH"
        );
        c["evaluation"]["split"] = json!("test");
        assert_eq!(
            compare(&b, &c, &[], &[])["reason"],
            "EVALUATION_PROTOCOL_MISMATCH"
        );
        b["evaluation"] = Value::Null;
        assert_eq!(
            compare(&b, &c, &[], &[])["reason"],
            "EVALUATION_SPEC_MISSING"
        );
    }
}
