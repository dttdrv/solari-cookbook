import assert from "node:assert/strict"
import test from "node:test"

import { buildWitnessReport, renderReport } from "./report.js"

const digest = "a".repeat(64)

test("builds a verified report and escapes biological metadata", () => {
  const report = buildWitnessReport({
    accession: "TEST.1",
    acquisitionUrl: "https://example.test/record",
    browserSessionId: "browser-1",
    replayBytes: 42,
    epigenesisCommit: digest,
    snapshotId: "snapshot-1",
    producerSandboxId: "producer-1",
    verifierSandboxId: "verifier-1",
    generatedAt: "2026-09-01T00:00:00.000Z",
    compiled: {
      artifact_sha256: digest,
      bio_ir_sha256: digest,
      bio_ir: { records: [{ record_id: "TEST.1", definition: "<script>alert(1)</script>", organism: { name: "Example" }, locus: { length: 100 }, features: [{ key: "gene", location: { text: "1..10", segments: [{ start: 0, end: 10, orientation: 1 }] } }] }] },
    },
    featureState: { artifact_sha256: digest },
    genbankValidation: { valid: true, inputs: { genbank_source_sha256: digest }, report_sha256: digest, checks: ["source-replay"], summary: { records: 1, sequence_bases: 100, features: 1, segments: 1 } },
    featureStateValidation: { valid: true, report_sha256: digest, checks: ["state-replay"], result: { units: 1, tensor_bytes: 88 } },
  })

  assert.equal(report.metrics.stateUnits, 1)
  const html = renderReport(report)
  assert.match(html, /independently replayed/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
})

test("refuses to publish failed replay", () => {
  assert.throws(() => buildWitnessReport({
    accession: "TEST.1",
    acquisitionUrl: "https://example.test",
    browserSessionId: "browser",
    replayBytes: 1,
    epigenesisCommit: digest,
    snapshotId: "snapshot",
    producerSandboxId: "producer",
    verifierSandboxId: "verifier",
    compiled: {},
    featureState: {},
    genbankValidation: { valid: false },
    featureStateValidation: { valid: true },
  }), /did not pass/)
})
