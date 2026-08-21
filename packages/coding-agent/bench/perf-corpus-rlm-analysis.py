#!/usr/bin/env python3
"""Deterministic, stdlib-only analysis of sealed perf-corpus schema-v3 reports.

Canonical execution compiles these exact externally authenticated bytes through
the trusted notebook template. Corpus JSON is data only: this module never
imports from the corpus, evaluates artifact text, starts a process, or accesses
the network.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from decimal import Decimal
import json
import math
import os
import stat
from pathlib import Path
from statistics import NormalDist
from typing import Any, Sequence

ANALYSIS_SCHEMA = "gjc.perf-corpus-rlm-analysis/1"
REPORT_SCHEMA = "gjc.perf-corpus/3"
PREREG_SCHEMA = "gjc.perf-corpus-preregistration/1"
SURFACES = ("cli", "agent-session", "blob-store", "worker", "telegram-daemon", "tui", "shared-native")
ELIGIBLE_SURFACES = ("agent-session", "tui")
EXTREMA_DOMAINS = ("rssBytes", "heapUsedBytes", "externalBytes", "arrayBuffersBytes")
SHARED_RUNNER_PROVENANCE_FIELDS = (
    "runtimeCommand",
    "closureDigest",
    "closureManifest",
    "bunVersion",
    "bunExecutable",
    "bunExecutableSha256",
    "worktreeFingerprint",
)
SAMPLE_FIELDS = (
    "elapsedMs",
    "rssBytes",
    "heapUsedBytes",
    "heapTotalBytes",
    "externalBytes",
    "arrayBuffersBytes",
    "activeResourceCount",
)
SAMPLING_FIELDS = (
    "periodicCadenceTargetMs",
    "highWaterCadenceTargetMs",
    "periodicDeadlinesMissed",
    "highWaterCallbacks",
    "highWaterProbes",
    "forcedHighWaterProbes",
    "throttledHighWaterCallbacks",
)
REPORT_FIELDS = {
    "schema",
    "generatedAt",
    "gitSha",
    "gitDirty",
    "runner",
    "fixtures",
    "hotspotClassifications",
    "thresholdLedger",
}
RUNNER_FIELDS = {
    "command",
    "argv",
    "environment",
    "platform",
    "arch",
    "bunVersion",
    "bunExecutable",
    "bunExecutableSha256",
    "ci",
    "profile",
    "durationTargetMs",
    "memoryIsolation",
    "memorySurfaceOrder",
    "iterationsTarget",
    "gcExposed",
    "memoryChildGcExposed",
    "memoryChildExecArgv",
    "runnerPid",
    "runtimeCommand",
    "runtimeControlIdentity",
    "closureDigest",
    "closureManifest",
    "worktreeFingerprint",
}
FIXTURE_FIELDS = {
    "fixtureId",
    "fixtureClass",
    "sourceClass",
    "workloadTags",
    "privacy",
    "wallClockPhase",
    "processCpuUsage",
    "profilerSelfTime",
    "rssMemory",
    "byteParity",
    "memoryBaseline",
}
BASELINE_FIELDS = {
    "surface",
    "profile",
    "iterations",
    "operations",
    "operationsPerSecond",
    "periodicSamples",
    "observedExtrema",
    "sampling",
    "postTeardown",
    "rssSlopeBytesPerSecond",
    "heapSlopeBytesPerSecond",
    "processTreeBaselineRssBytes",
    "processTreePostTeardownRssBytes",
    "processTreeSampler",
    "ordinal",
    "childPid",
    "parentPid",
    "captureSemanticsId",
}
CAPTURE_SEMANTICS_ID = "gjc.memory-baseline.capture/3"
BUN_VERSION = "1.3.14"
LOGICAL_BUN_EXECUTABLE = "bun"
RESULT_JSON = "perf-corpus-rlm-result.json"
RESULT_MARKDOWN = "perf-corpus-rlm-result.md"
NORMAL = NormalDist()
MAX_SAFE_INTEGER = 9_007_199_254_740_991
CANONICAL_RESAMPLES = 10_000
ATTEMPT_LEDGER_SCHEMA = "gjc.perf-corpus-attempt-ledger/1"
RAW_MANIFEST_SCHEMA = "gjc.perf-corpus-raw-manifest/1"
ATTEMPT_LEDGER_FILENAME = "perf-corpus-attempt-ledger.json"
RAW_MANIFEST_FILENAME = "perf-corpus-raw-manifest.json"
FIXTURE_CLASSES = ("startup-session-load", "streaming-ttft", "large-transcript", "high-output-tool", "edit-diff")
EVIDENCE_CLASSES = (
    "wall-clock-proxy",
    "process-cpu-usage",
    "profiler-self-time",
    "rss-memory",
    "byte-parity",
    "ledger-approved-threshold",
)
HOTSPOT_STATUSES = (
    "CPU-self-time confirmed",
    "fallback-toggle-confirmed",
    "covered-current",
    "not-visible",
    "needs-trace-coverage",
)
PROFILERS = ("bun", "node", "clinic", "instruments", "perf", "other", "none")
PARITY_VERDICTS = ("pass", "fail", "not-run")
EXPECTED_PREREGISTRATION_POLICY_SHA256 = "1fcadb3829aef34ca410b41c7146ec8843b9339ec27e57868467dfeed0ae027f"


class EvidenceError(Exception):
    """A deterministic admission or validation failure."""


def _object_no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise EvidenceError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise EvidenceError(f"non-finite JSON number: {value}")


def _json_depth(value: Any, depth: int = 0) -> int:
    if isinstance(value, dict):
        return max(([_json_depth(item, depth + 1) for item in value.values()] or [depth]))
    if isinstance(value, list):
        return max(([_json_depth(item, depth + 1) for item in value] or [depth]))
    return depth


def _load_json_bytes(raw: bytes, label: str, maximum_bytes: int, maximum_depth: int) -> Any:
    if not isinstance(raw, bytes):
        raise EvidenceError(f"{label} must be supplied as trusted bytes")
    if len(raw) > maximum_bytes:
        raise EvidenceError(f"file exceeds byte bound: {label}")
    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_object_no_duplicates,
            parse_constant=_reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise EvidenceError(f"invalid UTF-8 JSON in {label}: {error}") from error
    try:
        depth = _json_depth(value)
    except RecursionError as error:
        raise EvidenceError(f"JSON nesting exceeds depth bound: {label}") from error
    if depth > maximum_depth:
        raise EvidenceError(f"JSON nesting exceeds depth bound: {label}")
    return value


def _read_file_bytes(path: Path, maximum_bytes: int) -> tuple[bytes, os.stat_result]:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise EvidenceError(f"path is not a regular non-symlink file: {path.name}")
    if info.st_size > maximum_bytes:
        raise EvidenceError(f"file exceeds byte bound: {path.name}")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
        try:
            before = os.fstat(descriptor)
            raw = bytearray()
            while True:
                chunk = os.read(descriptor, min(1024 * 1024, maximum_bytes + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
                if len(raw) > maximum_bytes:
                    raise EvidenceError(f"file exceeds byte bound: {path.name}")
            after = os.fstat(descriptor)
        finally:
            os.close(descriptor)
    except OSError as error:
        raise EvidenceError(f"cannot read {path.name}: {error.strerror}") from error
    if (
        not stat.S_ISREG(before.st_mode)
        or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
        != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        or len(raw) != before.st_size
    ):
        raise EvidenceError(f"file changed while reading: {path.name}")
    return bytes(raw), before


def _canonical_digest(value: Any) -> str:
    return _sha256_bytes(
        json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    )


def _validate_seal(container: dict[str, Any], label: str) -> None:
    seal = _expect_dict(_required(container, "seal", label), f"{label}.seal")
    _expect_exact_keys(seal, {"algorithm", "digest"}, f"{label}.seal")
    if seal.get("algorithm") != "sha256-canonical-json":
        raise EvidenceError(f"{label}.seal algorithm drift")
    digest = _expect_sha256(seal.get("digest"), f"{label}.seal.digest")
    payload = {key: value for key, value in container.items() if key != "seal"}
    if digest != _canonical_digest(payload):
        raise EvidenceError(f"{label}.seal digest mismatch")


def _validate_private_field_names(value: Any, label: str, *, privacy_attestation: bool = False) -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            normalized = key.lower()
            permitted_attestation = privacy_attestation and key in {"rawPrivateTranscriptCommitted", "redactionNotes"}
            permitted_schema_field = key == "providerPayloadGolden"
            if not permitted_attestation and not permitted_schema_field and any(
                forbidden in normalized
                for forbidden in ("provider", "private", "transcript", "secret", "credential", "token", "username")
            ):
                raise EvidenceError(f"{label}.{key} is a forbidden private/provider field")
            _validate_private_field_names(
                nested,
                f"{label}.{key}",
                privacy_attestation=privacy_attestation or key == "privacy",
            )
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            _validate_private_field_names(nested, f"{label}[{index}]", privacy_attestation=privacy_attestation)


def _validate_logical_runner_argv(value: Any, label: str) -> list[str]:
    argv = _expect_list(value, label)
    logical_runner_script = "packages/coding-agent/bench/perf-corpus.bench.ts"
    allowed_argv = (
        (LOGICAL_BUN_EXECUTABLE, logical_runner_script),
        (LOGICAL_BUN_EXECUTABLE, "--smol", logical_runner_script),
        (LOGICAL_BUN_EXECUTABLE, "--expose-gc", logical_runner_script),
        (LOGICAL_BUN_EXECUTABLE, "--smol", "--expose-gc", logical_runner_script),
    )
    if tuple(argv) not in allowed_argv:
        raise EvidenceError(f"{label} must begin with bun and contain only logical repository-relative values")
    return argv


def _protocol_digest(prereg: dict[str, Any]) -> str:
    contract = _expect_dict(prereg.get("sealedInputContract"), "preregistration.sealedInputContract")
    fields = _validate_string_array(contract.get("protocolDigestFields"), "sealedInputContract.protocolDigestFields")
    return _canonical_digest({field: _required(prereg, field, "preregistration") for field in fields})


def _sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _expect_dict(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise EvidenceError(f"{label} must be an object")
    return value


def _expect_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise EvidenceError(f"{label} must be an array")
    return value


def _expect_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise EvidenceError(f"{label} must be a non-empty string")
    return value


def _expect_bool(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise EvidenceError(f"{label} must be boolean")
    return value


def _expect_number(value: Any, label: str, *, nonnegative: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise EvidenceError(f"{label} must be a finite number")
    numeric = float(value)
    if nonnegative and numeric < 0:
        raise EvidenceError(f"{label} must be non-negative")
    return numeric


def _expect_integer(value: Any, label: str, *, nonnegative: bool = False, positive: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or abs(value) > MAX_SAFE_INTEGER:
        raise EvidenceError(f"{label} must be a safe integer")
    if nonnegative and value < 0:
        raise EvidenceError(f"{label} must be non-negative")
    if positive and value <= 0:
        raise EvidenceError(f"{label} must be positive")
    return value


def _required(mapping: dict[str, Any], key: str, label: str) -> Any:
    if key not in mapping:
        raise EvidenceError(f"{label}.{key} is required")
    return mapping[key]
def _expect_exact_keys(mapping: dict[str, Any], expected: set[str], label: str) -> None:
    if set(mapping) != expected:
        missing = sorted(expected - set(mapping))
        unexpected = sorted(set(mapping) - expected)
        raise EvidenceError(f"{label} fields are invalid; missing={missing}, unexpected={unexpected}")


def _expect_sha256(value: Any, label: str) -> str:
    normalized = _expect_string(value, label)
    if len(normalized) != 64 or any(character not in "0123456789abcdef" for character in normalized):
        raise EvidenceError(f"{label} must be lowercase SHA-256")
    return normalized


def _expect_git_oid(value: Any, label: str) -> str:
    normalized = _expect_string(value, label)
    if len(normalized) != 40 or any(character not in "0123456789abcdef" for character in normalized):
        raise EvidenceError(f"{label} must be a lowercase 40-character Git object ID")
    return normalized


def _timestamp_seconds(value: Any, label: str) -> float:
    raw = _expect_string(value, label)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise EvidenceError(f"{label} must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None:
        raise EvidenceError(f"{label} must include a timezone")
    return parsed.astimezone(timezone.utc).timestamp()




def _median(values: Sequence[float]) -> float:
    if not values:
        raise EvidenceError("median requires at least one value")
    ordered = sorted(float(value) for value in values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0
def _rank(values: Sequence[float]) -> list[float]:
    ordered = sorted(range(len(values)), key=lambda index: values[index])
    ranks = [0.0] * len(values)
    cursor = 0
    while cursor < len(ordered):
        end = cursor + 1
        while end < len(ordered) and values[ordered[end]] == values[ordered[cursor]]:
            end += 1
        rank = (cursor + end - 1) / 2.0 + 1.0
        for position in range(cursor, end):
            ranks[ordered[position]] = rank
        cursor = end
    return ranks


def _spearman(left: Sequence[float], right: Sequence[float]) -> dict[str, Any]:
    if len(left) != len(right) or len(left) < 2:
        return {"coefficient": None, "pointCount": len(left), "reason": "fewer-than-two-paired-points"}
    left_ranks = _rank(left)
    right_ranks = _rank(right)
    left_mean = sum(left_ranks) / len(left_ranks)
    right_mean = sum(right_ranks) / len(right_ranks)
    numerator = sum((a - left_mean) * (b - right_mean) for a, b in zip(left_ranks, right_ranks))
    left_scale = sum((value - left_mean) ** 2 for value in left_ranks)
    right_scale = sum((value - right_mean) ** 2 for value in right_ranks)
    if left_scale == 0 or right_scale == 0:
        return {"coefficient": None, "pointCount": len(left), "reason": "constant-rank-input"}
    return {
        "coefficient": numerator / math.sqrt(left_scale * right_scale),
        "pointCount": len(left),
        "reason": None,
    }




def _summary(values: Sequence[float]) -> dict[str, Any]:
    if not values:
        raise EvidenceError("descriptive summary requires at least one value")
    points = [float(value) for value in values]
    median = _median(points)
    first_quartile = _quantile_type7(points, 0.25)
    third_quartile = _quantile_type7(points, 0.75)
    return {
        "count": len(points),
        "minimum": min(points),
        "median": median,
        "medianAbsoluteDeviation": _median([abs(value - median) for value in points]),
        "firstQuartile": first_quartile,
        "thirdQuartile": third_quartile,
        "interquartileRange": third_quartile - first_quartile,
        "maximum": max(points),
        "points": points,
    }


def _optional_summary(values: Sequence[float]) -> dict[str, Any]:
    if not values:
        return {
            "count": 0,
            "minimum": None,
            "median": None,
            "medianAbsoluteDeviation": None,
            "firstQuartile": None,
            "thirdQuartile": None,
            "interquartileRange": None,
            "maximum": None,
            "points": [],
        }
    return _summary(values)


def _quantile_type7(values: Sequence[float], probability: float) -> float:
    ordered = sorted(values)
    if not ordered:
        raise EvidenceError("quantile requires values")
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * min(1.0, max(0.0, probability))
    lower = math.floor(position)
    fraction = position - lower
    if lower >= len(ordered) - 1:
        return ordered[-1]
    return ordered[lower] + fraction * (ordered[lower + 1] - ordered[lower])


def _resample_index(seed: int, replicate: int, draw: int, block_count: int) -> int:
    material = f"{seed}:{replicate}:{draw}".encode("ascii")
    return int.from_bytes(hashlib.sha256(material).digest(), "big") % block_count


def _bca_interval(values: Sequence[float], seed: int) -> dict[str, float | int]:
    count = len(values)
    if count < 3:
        raise EvidenceError("BCa requires at least three whole report blocks")
    resamples = CANONICAL_RESAMPLES
    observed = _median(values)
    bootstrap: list[float] = []
    for replicate in range(resamples):
        bootstrap.append(_median([values[_resample_index(seed, replicate, draw, count)] for draw in range(count)]))
    less = sum(value < observed for value in bootstrap)
    equal = sum(value == observed for value in bootstrap)
    proportion = (less + 0.5 * equal) / resamples
    epsilon = 0.5 / resamples
    z0 = NORMAL.inv_cdf(min(1.0 - epsilon, max(epsilon, proportion)))
    jackknife = [_median(values[:index] + values[index + 1 :]) for index in range(count)]
    jack_mean = sum(jackknife) / count
    numerator = sum((jack_mean - value) ** 3 for value in jackknife)
    denominator_base = sum((jack_mean - value) ** 2 for value in jackknife)
    acceleration = 0.0 if denominator_base == 0 else numerator / (6.0 * denominator_base**1.5)

    def adjusted(probability: float) -> float:
        z_alpha = NORMAL.inv_cdf(probability)
        divisor = 1.0 - acceleration * (z0 + z_alpha)
        if divisor == 0:
            return 0.0 if z0 + z_alpha < 0 else 1.0
        return NORMAL.cdf(z0 + (z0 + z_alpha) / divisor)

    return {
        "confidenceLevel": 0.95,
        "resamples": resamples,
        "seed": seed,
        "lower": _quantile_type7(bootstrap, adjusted(0.025)),
        "upper": _quantile_type7(bootstrap, adjusted(0.975)),
        "biasCorrection": z0,
        "acceleration": acceleration,
    }


def _unit_only_bca_reference(values: Sequence[float]) -> dict[str, float | int]:
    """Private bounded statistical seam; it cannot read artifacts or write canonical evidence."""
    if len(values) < 3 or len(values) > 64:
        raise EvidenceError("unit-only BCa requires between 3 and 64 values")
    normalized = [_expect_number(value, f"unitValues[{index}]") for index, value in enumerate(values)]
    return _bca_interval(normalized, 0x3279B4E7)

def _derived_slope(numerator: float, elapsed_ms: float, label: str) -> float:
    if not math.isfinite(numerator) or not math.isfinite(elapsed_ms) or elapsed_ms <= 0:
        raise EvidenceError(f"{label} cannot be derived from non-finite or non-positive values")
    slope = numerator * 1000.0 / elapsed_ms
    if not math.isfinite(slope):
        raise EvidenceError(f"{label} is non-finite")
    return slope


def _endpoint_slope(samples: Sequence[dict[str, Any]], key: str) -> float | None:
    first, last = samples[0], samples[-1]
    duration = float(last["elapsedMs"] - first["elapsedMs"])
    if duration < 250:
        return None
    cutoff = float(first["elapsedMs"]) + min(250.0, duration / 4.0)
    steady = [sample for sample in samples if float(sample["elapsedMs"]) >= cutoff]
    steady_duration = float(steady[-1]["elapsedMs"] - steady[0]["elapsedMs"]) if len(steady) >= 2 else 0.0
    if len(steady) < 2 or steady_duration < 250:
        return None
    return _derived_slope(float(steady[-1][key] - steady[0][key]), steady_duration, f"{key} endpoint slope")


def _theil_sen(
    samples: Sequence[dict[str, Any]],
    maximum_samples: int,
    maximum_pairs: int,
    minimum_elapsed_delta_ms: float,
    minimum_absolute_slope: float,
) -> float | None:
    if len(samples) > maximum_samples:
        raise EvidenceError("periodicSamples exceeds fixed bound before Theil-Sen pair generation")
    duration = float(samples[-1]["elapsedMs"] - samples[0]["elapsedMs"])
    cutoff = float(samples[0]["elapsedMs"]) + min(250.0, duration / 4.0)
    steady = [sample for sample in samples if float(sample["elapsedMs"]) >= cutoff]
    pair_count = len(steady) * (len(steady) - 1) // 2
    if pair_count > maximum_pairs:
        raise EvidenceError("Theil-Sen pair bound exceeded before pair generation")
    slopes: list[float] = []
    for left in range(len(steady)):
        for right in range(left + 1, len(steady)):
            elapsed = float(steady[right]["elapsedMs"] - steady[left]["elapsedMs"])
            if elapsed < minimum_elapsed_delta_ms:
                raise EvidenceError("periodicSamples contain near-equal timestamps")
            slopes.append(
                _derived_slope(
                    float(steady[right]["heapUsedBytes"] - steady[left]["heapUsedBytes"]),
                    elapsed,
                    "Theil-Sen pair slope",
                )
            )
    if not slopes:
        return None
    result = _median(slopes)
    if not math.isfinite(result):
        raise EvidenceError("Theil-Sen heap slope is non-finite")
    return result


def _validate_sample(value: Any, label: str) -> dict[str, Any]:
    sample = _expect_dict(value, label)
    _expect_exact_keys(sample, set(SAMPLE_FIELDS), label)
    for field in SAMPLE_FIELDS:
        raw = _required(sample, field, label)
        if field == "activeResourceCount":
            _expect_integer(raw, f"{label}.{field}", nonnegative=True)
        elif field == "elapsedMs":
            _expect_number(raw, f"{label}.{field}", nonnegative=True)
        else:
            _expect_integer(raw, f"{label}.{field}", nonnegative=True)
    if sample["arrayBuffersBytes"] > sample["externalBytes"]:
        raise EvidenceError(f"{label}.arrayBuffersBytes exceeds externalBytes")
    return sample


def _validate_baseline(
    value: Any,
    label: str,
    profile: str,
    runner: dict[str, Any],
    profile_config: dict[str, Any],
    bounds: dict[str, Any],
) -> dict[str, Any]:
    baseline = _expect_dict(value, label)
    _expect_exact_keys(baseline, BASELINE_FIELDS, label)
    ordinal = _expect_integer(_required(baseline, "ordinal", label), f"{label}.ordinal", nonnegative=True)
    child_pid = _expect_integer(_required(baseline, "childPid", label), f"{label}.childPid", positive=True)
    parent_pid = _expect_integer(_required(baseline, "parentPid", label), f"{label}.parentPid", positive=True)
    if parent_pid != runner["runnerPid"] or child_pid == parent_pid:
        raise EvidenceError(f"{label} process identity does not match isolated runner")
    if baseline.get("captureSemanticsId") != CAPTURE_SEMANTICS_ID:
        raise EvidenceError(f"{label}.captureSemanticsId drift")
    if baseline.get("profile") != profile:
        raise EvidenceError(f"{label}.profile does not match runner profile")
    surface = baseline.get("surface")
    if surface not in SURFACES:
        raise EvidenceError(f"{label}.surface is invalid")
    iterations = _expect_integer(_required(baseline, "iterations", label), f"{label}.iterations", positive=True)
    if iterations < runner["iterationsTarget"]:
        raise EvidenceError(f"{label}.iterations is below target")
    _expect_integer(_required(baseline, "operations", label), f"{label}.operations", nonnegative=True)
    _expect_number(_required(baseline, "operationsPerSecond", label), f"{label}.operationsPerSecond", nonnegative=True)
    if "samples" in baseline:
        raise EvidenceError(f"{label}.samples is forbidden in schema v3")
    raw_samples = _expect_list(_required(baseline, "periodicSamples", label), f"{label}.periodicSamples")
    maximum_samples = profile_config["maximumPeriodicSamples"]
    if len(raw_samples) < 2:
        raise EvidenceError(f"{label}.periodicSamples requires at least two samples")
    if len(raw_samples) > maximum_samples:
        raise EvidenceError(f"{label}.periodicSamples exceeds fixed sample-count bound")
    final_raw = _expect_dict(raw_samples[-1], f"{label}.periodicSamples[-1]")
    final_elapsed = _expect_number(
        _required(final_raw, "elapsedMs", f"{label}.periodicSamples[-1]"),
        f"{label}.periodicSamples[-1].elapsedMs",
        nonnegative=True,
    )
    maximum_elapsed = profile_config["durationTargetMs"] + profile_config["elapsedDurationToleranceMs"]
    if final_elapsed > maximum_elapsed:
        raise EvidenceError(f"{label}.periodicSamples exceeds fixed elapsed-duration tolerance")
    samples = [_validate_sample(item, f"{label}.periodicSamples[{index}]") for index, item in enumerate(raw_samples)]
    if samples[0]["elapsedMs"] != 0:
        raise EvidenceError(f"{label}.periodicSamples must start at zero")
    for index in range(1, len(samples)):
        elapsed_delta = float(samples[index]["elapsedMs"] - samples[index - 1]["elapsedMs"])
        if elapsed_delta < bounds["minimumElapsedDeltaMs"]:
            raise EvidenceError(f"{label}.periodicSamples contain duplicate or near-equal timestamps")
    if profile == "soak" and samples[-1]["elapsedMs"] < runner["durationTargetMs"]:
        raise EvidenceError(f"{label}.periodicSamples is shorter than soak target")
    post = _validate_sample(_required(baseline, "postTeardown", label), f"{label}.postTeardown")
    if post["elapsedMs"] < samples[-1]["elapsedMs"]:
        raise EvidenceError(f"{label}.postTeardown predates measurement")
    extrema = _expect_dict(_required(baseline, "observedExtrema", label), f"{label}.observedExtrema")
    if set(extrema) != set(EXTREMA_DOMAINS):
        raise EvidenceError(f"{label}.observedExtrema must contain exactly four domains")
    for domain in EXTREMA_DOMAINS:
        item = _expect_dict(extrema[domain], f"{label}.observedExtrema.{domain}")
        if set(item) != {"valueBytes", "elapsedMs"}:
            raise EvidenceError(f"{label}.observedExtrema.{domain} has invalid fields")
        _expect_integer(item["valueBytes"], f"{label}.observedExtrema.{domain}.valueBytes", nonnegative=True)
        _expect_number(item["elapsedMs"], f"{label}.observedExtrema.{domain}.elapsedMs", nonnegative=True)
        if item["elapsedMs"] > samples[-1]["elapsedMs"]:
            raise EvidenceError(f"{label}.observedExtrema.{domain} lies outside measurement")
        if item["valueBytes"] < max(sample[domain] for sample in samples):
            raise EvidenceError(f"{label}.observedExtrema.{domain} is below a periodic observation")
    if extrema["arrayBuffersBytes"]["valueBytes"] > extrema["externalBytes"]["valueBytes"]:
        raise EvidenceError(f"{label}.observedExtrema array buffers exceed external")
    sampling = _expect_dict(_required(baseline, "sampling", label), f"{label}.sampling")
    if set(sampling) != set(SAMPLING_FIELDS):
        raise EvidenceError(f"{label}.sampling fields are invalid")
    for field in SAMPLING_FIELDS:
        _expect_integer(sampling[field], f"{label}.sampling.{field}", nonnegative=True)
    expected_periodic, expected_high_water = (50, 10) if profile == "soak" else (0, 0)
    if sampling["periodicCadenceTargetMs"] != expected_periodic or sampling["highWaterCadenceTargetMs"] != expected_high_water:
        raise EvidenceError(f"{label}.sampling cadence does not match profile")
    if sampling["highWaterCallbacks"] != sampling["highWaterProbes"] + sampling["throttledHighWaterCallbacks"]:
        raise EvidenceError(f"{label}.sampling callback counts are inconsistent")
    if sampling["forcedHighWaterProbes"] > sampling["highWaterProbes"]:
        raise EvidenceError(f"{label}.sampling forced probes exceed probes")
    for slope_field, sample_field in (("rssSlopeBytesPerSecond", "rssBytes"), ("heapSlopeBytesPerSecond", "heapUsedBytes")):
        actual = _required(baseline, slope_field, label)
        expected = _endpoint_slope(samples, sample_field)
        if actual is not None:
            actual = _expect_number(actual, f"{label}.{slope_field}")
        if (actual is None) != (expected is None):
            raise EvidenceError(f"{label}.{slope_field} nullability does not match periodic samples")
        if actual is not None and expected is not None and abs(actual - expected) > max(1e-9, abs(expected) * 1e-12):
            raise EvidenceError(f"{label}.{slope_field} does not match periodic samples")
    for field in ("processTreeBaselineRssBytes", "processTreePostTeardownRssBytes"):
        raw = _required(baseline, field, label)
        if raw is not None:
            _expect_integer(raw, f"{label}.{field}", nonnegative=True)
    sampler = _required(baseline, "processTreeSampler", label)
    if sampler not in ("ps", "unavailable"):
        raise EvidenceError(f"{label}.processTreeSampler is invalid")
    if sampler == "ps" and (baseline["processTreeBaselineRssBytes"] is None or baseline["processTreePostTeardownRssBytes"] is None):
        raise EvidenceError(f"{label} ps sampler requires process-tree values")
    if sampler == "unavailable" and (baseline["processTreeBaselineRssBytes"] is not None or baseline["processTreePostTeardownRssBytes"] is not None):
        raise EvidenceError(f"{label} unavailable sampler requires null process-tree values")
    theil_sen = _theil_sen(
        samples,
        maximum_samples,
        bounds["maximumTheilSenPairsPerBaseline"],
        bounds["minimumElapsedDeltaMs"],
        bounds["minimumAbsoluteActionSlopeBytesPerSecond"] if profile == "soak" else 0.0,
    )
    if profile == "soak":
        endpoint_heap = baseline["heapSlopeBytesPerSecond"]
        if endpoint_heap is None or theil_sen is None:
            raise EvidenceError(f"{label} does not support both preregistered heap-slope estimators")
        if not math.isfinite(float(endpoint_heap)):
            raise EvidenceError(f"{label}.heapSlopeBytesPerSecond is non-finite")
    return {
        "baseline": baseline,
        "samples": samples,
        "ordinal": ordinal,
        "childPid": child_pid,
        "theilSenHeapSlopeBytesPerSecond": theil_sen,
    }


def _validate_string_array(value: Any, label: str) -> list[str]:
    items = _expect_list(value, label)
    for index, item in enumerate(items):
        _expect_string(item, f"{label}[{index}]")
    return items


def _validate_report_containers(report: dict[str, Any], filename: str) -> None:
    classifications = _expect_list(report.get("hotspotClassifications"), f"{filename}.hotspotClassifications")
    for index, value in enumerate(classifications):
        label = f"{filename}.hotspotClassifications[{index}]"
        item = _expect_dict(value, label)
        _expect_exact_keys(item, {"hotspotId", "status", "evidenceClass", "artifactRefs", "notes"}, label)
        _expect_string(item.get("hotspotId"), f"{label}.hotspotId")
        if item.get("status") not in HOTSPOT_STATUSES:
            raise EvidenceError(f"{label}.status is invalid")
        if item.get("evidenceClass") not in EVIDENCE_CLASSES:
            raise EvidenceError(f"{label}.evidenceClass is invalid")
        _validate_string_array(item.get("artifactRefs"), f"{label}.artifactRefs")
        _expect_string(item.get("notes"), f"{label}.notes")
        if item["status"] == "CPU-self-time confirmed" and item["evidenceClass"] != "profiler-self-time":
            raise EvidenceError(f"{label} CPU confirmation requires profiler-self-time evidence")
    thresholds = _expect_list(report.get("thresholdLedger"), f"{filename}.thresholdLedger")
    for index, value in enumerate(thresholds):
        label = f"{filename}.thresholdLedger[{index}]"
        item = _expect_dict(value, label)
        _expect_exact_keys(item, {"name", "advisoryOrEnforced"}, label)
        _expect_string(item.get("name"), f"{label}.name")
        if item.get("advisoryOrEnforced") not in ("advisory", "enforced"):
            raise EvidenceError(f"{label}.advisoryOrEnforced is invalid")


def _validate_fixture_containers(fixture: dict[str, Any], label: str) -> None:
    _expect_string(fixture.get("fixtureId"), f"{label}.fixtureId")
    if fixture.get("fixtureClass") not in FIXTURE_CLASSES:
        raise EvidenceError(f"{label}.fixtureClass is invalid")
    tags = _validate_string_array(fixture.get("workloadTags"), f"{label}.workloadTags")
    if len(tags) != len(set(tags)):
        raise EvidenceError(f"{label}.workloadTags must be unique")
    privacy = _expect_dict(fixture.get("privacy"), f"{label}.privacy")
    _expect_exact_keys(privacy, {"rawPrivateTranscriptCommitted", "redactionNotes"}, f"{label}.privacy")
    if privacy.get("rawPrivateTranscriptCommitted") is not False:
        raise EvidenceError(f"{label}: raw private transcript content is forbidden")
    _expect_string(privacy.get("redactionNotes"), f"{label}.privacy.redactionNotes")
    wall_clock = _expect_dict(fixture.get("wallClockPhase"), f"{label}.wallClockPhase")
    for phase, raw_metric in wall_clock.items():
        _expect_string(phase, f"{label}.wallClockPhase key")
        metric_label = f"{label}.wallClockPhase.{phase}"
        metric = _expect_dict(raw_metric, metric_label)
        allowed = {"elapsedMs", "startMs", "p50Ms", "p95Ms", "advisoryOnly"}
        if not {"elapsedMs", "advisoryOnly"} <= set(metric) or not set(metric) <= allowed:
            raise EvidenceError(f"{metric_label} fields are invalid")
        for field in set(metric) - {"advisoryOnly"}:
            _expect_number(metric[field], f"{metric_label}.{field}", nonnegative=True)
        _expect_bool(metric.get("advisoryOnly"), f"{metric_label}.advisoryOnly")
    process_cpu = _expect_dict(fixture.get("processCpuUsage"), f"{label}.processCpuUsage")
    for phase, raw_metric in process_cpu.items():
        _expect_string(phase, f"{label}.processCpuUsage key")
        metric_label = f"{label}.processCpuUsage.{phase}"
        metric = _expect_dict(raw_metric, metric_label)
        allowed = {"userMicros", "systemMicros", "elapsedMs", "cpuFraction"}
        if not {"userMicros", "systemMicros", "elapsedMs"} <= set(metric) or not set(metric) <= allowed:
            raise EvidenceError(f"{metric_label} fields are invalid")
        for field in metric:
            _expect_number(metric[field], f"{metric_label}.{field}", nonnegative=True)
    profiler = _expect_dict(fixture.get("profilerSelfTime"), f"{label}.profilerSelfTime")
    if not {"profiler"} <= set(profiler) or not set(profiler) <= {"profiler", "artifactPath", "samples"}:
        raise EvidenceError(f"{label}.profilerSelfTime fields are invalid")
    if profiler.get("profiler") not in PROFILERS:
        raise EvidenceError(f"{label}.profilerSelfTime.profiler is invalid")
    if "artifactPath" in profiler:
        _expect_string(profiler["artifactPath"], f"{label}.profilerSelfTime.artifactPath")
    if "samples" in profiler:
        for index, raw_sample in enumerate(_expect_list(profiler["samples"], f"{label}.profilerSelfTime.samples")):
            sample_label = f"{label}.profilerSelfTime.samples[{index}]"
            item = _expect_dict(raw_sample, sample_label)
            if not {"symbol", "selfTimeMs"} <= set(item) or not set(item) <= {"symbol", "selfTimeMs", "totalTimeMs", "package"}:
                raise EvidenceError(f"{sample_label} fields are invalid")
            _expect_string(item.get("symbol"), f"{sample_label}.symbol")
            _expect_number(item.get("selfTimeMs"), f"{sample_label}.selfTimeMs", nonnegative=True)
            if "totalTimeMs" in item:
                _expect_number(item["totalTimeMs"], f"{sample_label}.totalTimeMs", nonnegative=True)
            if "package" in item:
                _expect_string(item["package"], f"{sample_label}.package")
    rss = _expect_dict(fixture.get("rssMemory"), f"{label}.rssMemory")
    if not {"baselineBytes", "growthBytes", "returnBytes"} <= set(rss) or not set(rss) <= {
        "baselineBytes", "peakBytes", "growthBytes", "returnBytes", "heapBaselineBytes", "heapReturnBytes"
    }:
        raise EvidenceError(f"{label}.rssMemory fields are invalid")
    for field, raw in rss.items():
        if raw is not None:
            if field == "growthBytes":
                _expect_integer(raw, f"{label}.rssMemory.{field}")
            else:
                _expect_integer(raw, f"{label}.rssMemory.{field}", nonnegative=True)
    parity = _expect_dict(fixture.get("byteParity"), f"{label}.byteParity")
    if not set(parity) <= {"renderedGolden", "persistedJsonlGolden", "providerPayloadGolden", "materializedSessionGolden"}:
        raise EvidenceError(f"{label}.byteParity fields are invalid")
    for field, verdict in parity.items():
        if verdict not in PARITY_VERDICTS:
            raise EvidenceError(f"{label}.byteParity.{field} is invalid")

def _validate_report(value: Any, schedule: dict[str, Any], prereg: dict[str, Any], expected_git_sha: str) -> dict[str, Any]:
    filename = schedule["expectedFilename"]
    report = _expect_dict(value, filename)
    _validate_private_field_names(report, filename)
    _expect_exact_keys(report, REPORT_FIELDS, filename)
    if report.get("schema") != REPORT_SCHEMA:
        raise EvidenceError(f"{filename}: schema must be {REPORT_SCHEMA}")
    if report.get("gitSha") != expected_git_sha or not isinstance(report.get("gitSha"), str):
        raise EvidenceError(f"{filename}: gitSha mismatch")
    if _expect_bool(report.get("gitDirty"), f"{filename}.gitDirty"):
        raise EvidenceError(f"{filename}: gitDirty must be false")
    captured_at = _timestamp_seconds(report.get("generatedAt"), f"{filename}.generatedAt")
    runner = _expect_dict(report.get("runner"), f"{filename}.runner")
    _expect_exact_keys(runner, RUNNER_FIELDS, f"{filename}.runner")
    profile = schedule["profile"]
    profile_config = prereg["cohort"]["profiles"][profile]
    if runner.get("profile") != profile:
        raise EvidenceError(f"{filename}: profile mismatch")
    if runner.get("durationTargetMs") != profile_config["durationTargetMs"]:
        raise EvidenceError(f"{filename}: duration target drift")
    if runner.get("iterationsTarget") != profile_config["iterationsTarget"]:
        raise EvidenceError(f"{filename}: iterations target drift")
    if runner.get("memoryIsolation") != prereg["cohort"]["memoryIsolation"]:
        raise EvidenceError(f"{filename}: memory isolation drift")
    for field in ("gcExposed", "memoryChildGcExposed", "ci"):
        _expect_bool(runner.get(field), f"{filename}.runner.{field}")
    if runner.get("memoryChildGcExposed") is not True or runner.get("memoryChildExecArgv") != ["--smol", "--expose-gc"]:
        raise EvidenceError(f"{filename}: isolated child controls drift")
    command = _expect_string(runner.get("command"), f"{filename}.runner.command")
    if runner.get("runtimeCommand") != command:
        raise EvidenceError(f"{filename}: runtimeCommand must equal command")
    argv = _validate_logical_runner_argv(runner.get("argv"), f"{filename}.runner.argv")
    if command != " ".join(argv):
        raise EvidenceError(f"{filename}: runner.command must exactly match the logical runner.argv")
    platform = _expect_string(runner.get("platform"), f"{filename}.runner.platform")
    arch = _expect_string(runner.get("arch"), f"{filename}.runner.arch")
    if runner.get("bunVersion") != BUN_VERSION:
        raise EvidenceError(f"{filename}: Bun version drift")
    bun_executable = _expect_string(runner.get("bunExecutable"), f"{filename}.runner.bunExecutable")
    if bun_executable != LOGICAL_BUN_EXECUTABLE:
        raise EvidenceError(f'{filename}: bunExecutable must be the logical identifier "bun"')
    _expect_sha256(runner.get("bunExecutableSha256"), f"{filename}.runner.bunExecutableSha256")
    worktree_fingerprint = _expect_sha256(runner.get("worktreeFingerprint"), f"{filename}.runner.worktreeFingerprint")
    runner_pid = _expect_integer(runner.get("runnerPid"), f"{filename}.runner.runnerPid", positive=True)
    expected_order = schedule["surfaceOrder"]
    if runner.get("memorySurfaceOrder") != expected_order:
        raise EvidenceError(f"{filename}: preregistered memory surface order mismatch")
    environment = _expect_dict(runner.get("environment"), f"{filename}.runner.environment")
    expected_controls = {
        "GJC_MEMORY_PROFILE": profile,
        "GJC_MEMORY_ITERATIONS": str(profile_config["iterationsTarget"]),
        "GJC_MEMORY_SURFACE_ORDER": ",".join(expected_order),
    }
    if profile == "soak":
        expected_controls["GJC_MEMORY_DURATION_MS"] = str(profile_config["durationTargetMs"])
    if environment != expected_controls:
        raise EvidenceError(f"{filename}: runner.environment exact controls drift")
    identity_source = {
        "runtimeCommand": command,
        "argv": argv,
        "environment": environment,
        "platform": platform,
        "arch": arch,
        "bunVersion": runner["bunVersion"],
        "bunExecutable": bun_executable,
        "bunExecutableSha256": runner["bunExecutableSha256"],
        "worktreeFingerprint": worktree_fingerprint,
        "closureDigest": runner["closureDigest"],
        "closureManifest": runner["closureManifest"],
        "profile": profile,
        "durationTargetMs": profile_config["durationTargetMs"],
        "memoryIsolation": prereg["cohort"]["memoryIsolation"],
        "memorySurfaceOrder": expected_order,
        "iterationsTarget": profile_config["iterationsTarget"],
        "gcExposed": runner["gcExposed"],
        "memoryChildGcExposed": runner["memoryChildGcExposed"],
        "memoryChildExecArgv": runner["memoryChildExecArgv"],
        "runnerPid": runner_pid,
        "captureSemanticsId": CAPTURE_SEMANTICS_ID,
    }
    expected_identity = _sha256_bytes(
        json.dumps(identity_source, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    )
    if runner.get("runtimeControlIdentity") != expected_identity:
        raise EvidenceError(f"{filename}: runtimeControlIdentity mismatch")
    closure_manifest = _expect_list(runner.get("closureManifest"), f"{filename}.runner.closureManifest")
    if not closure_manifest or any(not isinstance(item, str) or not item for item in closure_manifest):
        raise EvidenceError(f"{filename}: closureManifest must be a non-empty string array")
    if closure_manifest != sorted(set(closure_manifest)):
        raise EvidenceError(f"{filename}: closureManifest must be sorted and unique")
    for index, item in enumerate(closure_manifest):
        try:
            member_path, digest = item.rsplit(":", 1)
        except ValueError as error:
            raise EvidenceError(f"{filename}: closureManifest[{index}] is invalid") from error
        segments = member_path.split("/")
        if (
            not member_path
            or member_path.startswith("/")
            or "\\" in member_path
            or any(segment in ("", ".", "..") for segment in segments)
        ):
            raise EvidenceError(f"{filename}: closureManifest[{index}] path is invalid")
        _expect_sha256(digest, f"{filename}.runner.closureManifest[{index}] digest")
    expected_closure_digest = _sha256_bytes(("\n".join(closure_manifest) + "\n").encode("utf-8"))
    if runner.get("closureDigest") != expected_closure_digest:
        raise EvidenceError(f"{filename}: closureDigest mismatch")
    _validate_report_containers(report, filename)
    fixtures = _expect_list(report.get("fixtures"), f"{filename}.fixtures")
    baselines: dict[str, dict[str, Any]] = {}
    observed_order: list[str] = []
    child_pids: set[int] = set()
    for index, fixture_value in enumerate(fixtures):
        fixture_label = f"{filename}.fixtures[{index}]"
        fixture = _expect_dict(fixture_value, fixture_label)
        baseline_value = fixture.get("memoryBaseline")
        expected_fixture_fields = FIXTURE_FIELDS if baseline_value is not None else FIXTURE_FIELDS - {"memoryBaseline"}
        _expect_exact_keys(fixture, expected_fixture_fields, fixture_label)
        if fixture.get("sourceClass") != "synthetic":
            raise EvidenceError(f"{fixture_label}.sourceClass must be synthetic")
        _validate_fixture_containers(fixture, fixture_label)
        if baseline_value is None:
            continue
        validated = _validate_baseline(
            baseline_value,
            f"{fixture_label}.memoryBaseline",
            profile,
            runner,
            profile_config,
            prereg["bounds"],
        )
        if validated["ordinal"] != len(observed_order):
            raise EvidenceError(f"{fixture_label}: memory baseline ordinal does not match surface order")
        if validated["childPid"] in child_pids:
            raise EvidenceError(f"{filename}: isolated child PIDs must be distinct")
        child_pids.add(validated["childPid"])
        _expect_string(fixture.get("fixtureId"), f"{fixture_label}.fixtureId")
        wall_clock = _expect_dict(fixture.get("wallClockPhase"), f"{fixture_label}.wallClockPhase")
        run_metric = _expect_dict(wall_clock.get("run"), f"{fixture_label}.wallClockPhase.run")
        run_elapsed_ms = _expect_number(run_metric.get("elapsedMs"), f"{fixture_label}.wallClockPhase.run.elapsedMs", nonnegative=True)
        if run_elapsed_ms != validated["samples"][-1]["elapsedMs"]:
            raise EvidenceError(f"{fixture_label}: final periodic sample does not match run duration")
        measured = validated["baseline"]
        expected_throughput = measured["operations"] / max(run_elapsed_ms / 1000.0, 1e-6)
        if abs(float(measured["operationsPerSecond"]) - expected_throughput) > max(1e-9, abs(expected_throughput) * 1e-12):
            raise EvidenceError(f"{fixture_label}: operationsPerSecond does not match operations")
        rss_memory = _expect_dict(fixture.get("rssMemory"), f"{fixture_label}.rssMemory")
        expected_rss_summary = {
            "baselineBytes": validated["samples"][0]["rssBytes"],
            "peakBytes": measured["observedExtrema"]["rssBytes"]["valueBytes"],
            "growthBytes": measured["observedExtrema"]["rssBytes"]["valueBytes"] - validated["samples"][0]["rssBytes"],
            "returnBytes": measured["postTeardown"]["rssBytes"],
            "heapBaselineBytes": validated["samples"][0]["heapUsedBytes"],
            "heapReturnBytes": measured["postTeardown"]["heapUsedBytes"],
        }
        if set(rss_memory) != set(expected_rss_summary) or any(
            rss_memory[field] != expected for field, expected in expected_rss_summary.items()
        ):
            raise EvidenceError(f"{fixture_label}: rssMemory summary does not match periodic/extrema evidence")
        surface = measured["surface"]
        if surface in baselines:
            raise EvidenceError(f"{filename}: duplicate memory surface {surface}")
        baselines[surface] = validated
        observed_order.append(surface)
    if set(baselines) != set(SURFACES) or len(baselines) != len(SURFACES):
        raise EvidenceError(f"{filename}: exactly seven required memory surfaces are required")
    if observed_order != expected_order:
        raise EvidenceError(f"{filename}: fixture order does not match preregistered order")
    return {
        "blockId": schedule["slotId"],
        "attemptId": schedule["attemptId"],
        "attemptNumber": schedule["attemptNumber"],
        "admissionNumber": schedule["admissionNumber"],
        "filename": filename,
        "profile": profile,
        "platform": platform,
        "arch": arch,
        "capturedAtSeconds": captured_at,
        "runnerProvenance": {
            key: runner[key]
            for key in (
                "runtimeCommand",
                "closureDigest",
                "closureManifest",
                "bunVersion",
                "bunExecutable",
                "bunExecutableSha256",
                "worktreeFingerprint",
            )
        },
        "runnerPid": runner_pid,
        "baselines": baselines,
        "observedOrder": observed_order,
    }


def _validate_preregistration(value: Any) -> dict[str, Any]:
    prereg = _expect_dict(value, "preregistration")
    _expect_exact_keys(
        prereg,
        {
            "schema",
            "analysisSchema",
            "reportSchema",
            "frozenBeforeOutcomes",
            "digestBinding",
            "cohort",
            "bounds",
            "analysis",
            "exclusions",
            "captureControls",
            "sealedInputContract",
            "trustedCodePolicy",
            "limitations",
        },
        "preregistration",
    )
    if _canonical_digest(prereg) != EXPECTED_PREREGISTRATION_POLICY_SHA256:
        raise EvidenceError("authenticated preregistration policy drift")
    if prereg.get("schema") != PREREG_SCHEMA or prereg.get("analysisSchema") != ANALYSIS_SCHEMA or prereg.get("reportSchema") != REPORT_SCHEMA:
        raise EvidenceError("preregistration schema binding is invalid")
    if prereg.get("frozenBeforeOutcomes") is not True:
        raise EvidenceError("preregistration was not frozen before outcomes")
    digest_binding = _expect_dict(prereg.get("digestBinding"), "preregistration.digestBinding")
    if (
        digest_binding.get("method") != "external-sha256-receipts-after-freeze"
        or digest_binding.get("embeddedDigests") is not False
        or digest_binding.get("requiredExternalReceipts")
        != ["templateSha256", "driverSha256", "preregistrationSha256"]
    ):
        raise EvidenceError("preregistration external digest binding drift")
    trusted_policy = _expect_dict(prereg.get("trustedCodePolicy"), "preregistration.trustedCodePolicy")
    if (
        trusted_policy.get("artifactRole") != "data-only"
        or trusted_policy.get("driverRole") != "reviewed-trusted-code-bytes"
        or trusted_policy.get("launcherRole") != "externally-authenticated-template"
        or "immutable read-only mount" not in str(trusted_policy.get("inputDirectory", ""))
    ):
        raise EvidenceError("preregistration trusted-code policy drift")
    sealed_contract = _expect_dict(prereg.get("sealedInputContract"), "preregistration.sealedInputContract")
    if (
        sealed_contract.get("loadAverage1mDriftScope")
        != "Compare telemetryBefore.loadAverage1m across attempts as a one-sided upward increase from the first attempt telemetryBefore value: a later value minus the first value must be less than or equal to maximumLoadAverage1mDrift. Lower later values do not violate ambient drift. telemetryAfter does not participate in ambient drift but remains required, absolutely bounded, and diagnostic."
        or sealed_contract.get("freeMemoryFractionDriftScope")
        != "Compare every telemetryBefore.freeMemoryBytes and telemetryAfter.freeMemoryBytes value against the first attempt telemetryBefore value."
    ):
        raise EvidenceError("preregistration telemetry drift scope drift")
    bounds = _expect_dict(prereg.get("bounds"), "preregistration.bounds")
    expected_bounds = {
        "maximumInputFiles": 39,
        "maximumBytesPerFile": 8_388_608,
        "maximumTotalInputBytes": 134_217_728,
        "maximumJsonDepth": 40,
        "maximumMarkdownBytes": 65_536,
        "minimumElapsedDeltaMs": 0.001,
        "minimumAbsoluteActionSlopeBytesPerSecond": 0,
        "maximumTheilSenPairsPerBaseline": 181_503,
    }
    if set(bounds) != set(expected_bounds):
        raise EvidenceError("preregistration bounds fields drift")
    for field, expected in expected_bounds.items():
        raw = bounds.get(field)
        if isinstance(expected, int):
            _expect_integer(raw, f"preregistration.bounds.{field}", nonnegative=True)
        else:
            _expect_number(raw, f"preregistration.bounds.{field}", nonnegative=True)
        if raw != expected:
            raise EvidenceError(f"preregistration bound drift: {field}")
    cohort = _expect_dict(prereg.get("cohort"), "preregistration.cohort")
    profiles = _expect_dict(cohort.get("profiles"), "preregistration.cohort.profiles")
    expected_profiles = {
        "short": {
            "requiredAdmittedBlocks": 5,
            "attemptCap": 7,
            "durationTargetMs": 0,
            "iterationsTarget": 200,
            "maximumPeriodicSamples": 22,
            "elapsedDurationToleranceMs": 30_000,
        },
        "soak": {
            "requiredAdmittedBlocks": 24,
            "attemptCap": 30,
            "durationTargetMs": 30_000,
            "iterationsTarget": 100000,
            "maximumPeriodicSamples": 603,
            "elapsedDurationToleranceMs": 250,
        },
    }
    if set(profiles) != set(expected_profiles):
        raise EvidenceError("preregistration profile set drift")
    for profile, expected in expected_profiles.items():
        config = _expect_dict(profiles.get(profile), f"preregistration.cohort.profiles.{profile}")
        if config != expected:
            raise EvidenceError(f"preregistration {profile} count/cap/control drift")
    if cohort.get("sharedRunnerProvenanceFields") != list(SHARED_RUNNER_PROVENANCE_FIELDS):
        raise EvidenceError("preregistration shared runner provenance fields drift")
    controls = _expect_dict(prereg.get("captureControls"), "preregistration.captureControls")
    if controls.get("requiredSurfaces") != list(SURFACES):
        raise EvidenceError("preregistration required surface drift")
    permutation = _expect_dict(controls.get("permutationGeneration"), "preregistration.captureControls.permutationGeneration")
    if (
        permutation.get("performedBeforeOutcomes") is not True
        or permutation.get("seed") != 0x3279B4E7
        or permutation.get("seedExpression") != "0x3279B4E7"
        or permutation.get("algorithm")
        != "Sort the seven UTF-8 surface names by raw SHA-256 of '0x3279B4E7:<profile>:<surface>' to obtain a seeded base row, then use cyclic rotations. Soak slots 1-21 are three complete seven-row Latin cycles; slots 22-24 are fixed rotations 1, 3, and 5. Short slots use the first five rotations. An invalid attempt does not advance the admission slot, so its replacement reuses the same row."
    ):
        raise EvidenceError("preregistration counterbalancing algorithm drift")
    admission_rows = _expect_dict(controls.get("admissionRows"), "preregistration.captureControls.admissionRows")
    base_rows = {
        "short": ["tui", "telegram-daemon", "shared-native", "blob-store", "agent-session", "worker", "cli"],
        "soak": ["blob-store", "shared-native", "worker", "agent-session", "tui", "cli", "telegram-daemon"],
    }
    rotation_indexes = {
        "short": list(range(5)),
        "soak": [index % 7 for index in range(21)] + [1, 3, 5],
    }
    for profile in ("short", "soak"):
        rows = _expect_list(admission_rows.get(profile), f"preregistration.captureControls.admissionRows.{profile}")
        expected_count = expected_profiles[profile]["requiredAdmittedBlocks"]
        if len(rows) != expected_count:
            raise EvidenceError(f"preregistration {profile} admission-row count mismatch")
        for index, raw in enumerate(rows):
            item = _expect_dict(raw, f"admissionRows.{profile}[{index}]")
            _expect_exact_keys(item, {"slotId", "surfaceOrder"}, f"admissionRows.{profile}[{index}]")
            base = base_rows[profile]
            rotation = rotation_indexes[profile][index]
            expected_order = base[rotation:] + base[:rotation]
            if item.get("slotId") != f"{profile}-slot-{index + 1:02d}" or item.get("surfaceOrder") != expected_order:
                raise EvidenceError(f"preregistration {profile} admission-row {index + 1} drift")
    schedule = _expect_list(controls.get("schedule"), "preregistration.captureControls.schedule")
    if len(schedule) != 37:
        raise EvidenceError("preregistration schedule must contain 37 frozen attempt allocations")
    expected_schedule: list[tuple[str, int]] = []
    short_after_soak = {2: 1, 6: 2, 10: 3, 14: 4, 18: 5, 22: 6, 26: 7}
    for soak_attempt in range(1, 31):
        expected_schedule.append(("soak", soak_attempt))
        if soak_attempt in short_after_soak:
            expected_schedule.append(("short", short_after_soak[soak_attempt]))
    filenames: set[str] = set()
    for index, raw in enumerate(schedule):
        item = _expect_dict(raw, f"preregistration.captureControls.schedule[{index}]")
        _expect_exact_keys(item, {"attemptId", "profile", "attemptNumber", "expectedFilename"}, f"schedule[{index}]")
        profile, attempt_number = expected_schedule[index]
        attempt_id = f"{profile}-{attempt_number:02d}"
        if (
            item.get("profile") != profile
            or item.get("attemptNumber") != attempt_number
            or item.get("attemptId") != attempt_id
            or item.get("expectedFilename") != f"{attempt_id}.json"
        ):
            raise EvidenceError(f"preregistration schedule[{index}] allocation/interleave drift")
        if item["expectedFilename"] in filenames:
            raise EvidenceError("preregistration schedule filenames must be unique")
        filenames.add(item["expectedFilename"])
    analysis = _expect_dict(prereg.get("analysis"), "preregistration.analysis")
    action = _expect_dict(analysis.get("actionFamily"), "preregistration.analysis.actionFamily")
    bootstrap = _expect_dict(action.get("bootstrap"), "preregistration.analysis.actionFamily.bootstrap")
    p95_receipt = _expect_dict(analysis.get("p95MethodReceipt"), "preregistration.analysis.p95MethodReceipt")
    if (
        cohort.get("allMembersRequired") is not True
        or cohort.get("gitDirtyRequired") is not False
        or cohort.get("memoryIsolation") != "process-per-surface"
        or cohort.get("sameGitShaPlatformAndArchRequired") is not True
        or cohort.get("independentReportBlocks") is not True
        or action.get("name") != "sustained-heap-growth"
        or action.get("eligibleSurfaces") != list(ELIGIBLE_SURFACES)
        or action.get("eligibleProfile") != "soak"
        or action.get("primaryEstimator") != "report-endpoint-heapSlopeBytesPerSecond"
        or action.get("sensitivityEstimator") != "per-report-steady-state-Theil-Sen-heapUsedBytes-slope"
        or action.get("aggregation") != "median-across-all-independent-report-blocks"
        or action.get("minimumPositiveSignsPerEstimatorPerSurface") != 18
        or action.get("minimumBcaLowerBoundBytesPerSecond") != 1_048_576 / 30
        or action.get("minimumBcaLowerBoundExpression") != "1048576/30"
        or action.get("noMultiplicityExpansion") is not True
        or "conjunctive" not in str(action.get("decision", ""))
        or bootstrap.get("method") != "two-sided-95-percent-BCa"
        or bootstrap.get("resamples") != 10000
        or bootstrap.get("resampleOverrideAllowed") is not False
        or bootstrap.get("unit") != "whole-report-block"
        or bootstrap.get("jointSurfaceResampling") is not True
        or bootstrap.get("seed") != 0x3279B4E7
        or bootstrap.get("seedExpression") != "0x3279B4E7"
        or bootstrap.get("indexGenerator") != "sha256(seed:replicate:draw)-modulo-block-count"
        or bootstrap.get("quantile") != "Hyndman-Fan-type-7"
        or bootstrap.get("biasTies") != "half-weight"
        or analysis.get("p95Claim") != "omitted-impossible-with-24-independent-blocks"
        or p95_receipt.get("method") != "two-sided-distribution-free-exact-order-statistic-interval"
        or p95_receipt.get("populationQuantile") != 0.95
        or p95_receipt.get("confidenceLevel") != 0.95
        or p95_receipt.get("independentBlockCount") != 24
        or p95_receipt.get("finiteUpperEndpointAvailable") is not False
    ):
        raise EvidenceError("preregistered decision policy drift")
    return prereg


def _surface_descriptives(reports: Sequence[dict[str, Any]], surface: str) -> dict[str, Any]:
    validated = [report["baselines"][surface] for report in reports]
    baselines = [item["baseline"] for item in validated]
    result: dict[str, Any] = {
        "endpointHeapSlopeBytesPerSecond": _optional_summary([float(item["heapSlopeBytesPerSecond"]) for item in baselines if item["heapSlopeBytesPerSecond"] is not None]),
        "theilSenHeapSlopeBytesPerSecond": _optional_summary([float(item["theilSenHeapSlopeBytesPerSecond"]) for item in validated if item["theilSenHeapSlopeBytesPerSecond"] is not None]),
        "endpointRssSlopeBytesPerSecond": _optional_summary([float(item["rssSlopeBytesPerSecond"]) for item in baselines if item["rssSlopeBytesPerSecond"] is not None]),
        "operationsPerSecond": _summary([float(item["operationsPerSecond"]) for item in baselines]),
        "iterations": _summary([float(item["iterations"]) for item in baselines]),
        "operations": _summary([float(item["operations"]) for item in baselines]),
        "periodicSampleCount": _summary([float(len(item["periodicSamples"])) for item in baselines]),
        "postTeardown": {},
        "observedExtrema": {},
        "sampling": {},
        "processTree": {
            "baselineRssBytes": _optional_summary([float(item["processTreeBaselineRssBytes"]) for item in baselines if item["processTreeBaselineRssBytes"] is not None]),
            "postTeardownRssBytes": _optional_summary([float(item["processTreePostTeardownRssBytes"]) for item in baselines if item["processTreePostTeardownRssBytes"] is not None]),
            "samplerCounts": {
                "ps": sum(item["processTreeSampler"] == "ps" for item in baselines),
                "unavailable": sum(item["processTreeSampler"] == "unavailable" for item in baselines),
            },
        },
        "rssMemorySummary": {
            "baselineBytes": _summary([float(item["periodicSamples"][0]["rssBytes"]) for item in baselines]),
            "peakBytes": _summary([float(item["observedExtrema"]["rssBytes"]["valueBytes"]) for item in baselines]),
            "growthBytes": _summary([float(item["observedExtrema"]["rssBytes"]["valueBytes"] - item["periodicSamples"][0]["rssBytes"]) for item in baselines]),
            "returnBytes": _summary([float(item["postTeardown"]["rssBytes"]) for item in baselines]),
            "heapBaselineBytes": _summary([float(item["periodicSamples"][0]["heapUsedBytes"]) for item in baselines]),
            "heapReturnBytes": _summary([float(item["postTeardown"]["heapUsedBytes"]) for item in baselines]),
        },
    }
    for field in SAMPLE_FIELDS:
        result["postTeardown"][field] = _summary([float(item["postTeardown"][field]) for item in baselines])
    for domain in EXTREMA_DOMAINS:
        result["observedExtrema"][domain] = {
            "valueBytes": _summary([float(item["observedExtrema"][domain]["valueBytes"]) for item in baselines]),
            "elapsedMs": _summary([float(item["observedExtrema"][domain]["elapsedMs"]) for item in baselines]),
        }
    for field in SAMPLING_FIELDS:
        result["sampling"][field] = _summary([float(item["sampling"][field]) for item in baselines])
    return result
def _run_level_points(reports: Sequence[dict[str, Any]], surface: str) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = []
    for report in reports:
        validated = report["baselines"][surface]
        baseline = validated["baseline"]
        points.append(
            {
                "blockId": report["blockId"],
                "attemptId": report["attemptId"],
                "attemptNumber": report["attemptNumber"],
                "admissionNumber": report["admissionNumber"],
                "capturedAtSeconds": report["capturedAtSeconds"],
                "surfaceOrdinal": validated["ordinal"],
                "thermalState": report["captureTelemetry"]["telemetryBefore"]["thermalState"]["value"],
                "memoryPressure": report["captureTelemetry"]["telemetryBefore"]["memoryPressure"]["value"],
                "loadAverage1m": report["captureTelemetry"]["telemetryBefore"]["loadAverage1m"]["value"],
                "freeMemoryBytes": report["captureTelemetry"]["telemetryBefore"]["freeMemoryBytes"]["value"],
                "endpointHeapSlopeBytesPerSecond": baseline["heapSlopeBytesPerSecond"],
                "theilSenHeapSlopeBytesPerSecond": validated["theilSenHeapSlopeBytesPerSecond"],
                "endpointRssSlopeBytesPerSecond": baseline["rssSlopeBytesPerSecond"],
                "operationsPerSecond": baseline["operationsPerSecond"],
            }
        )
    return points


def _estimator_sensitivities(reports: Sequence[dict[str, Any]], surface: str, estimator: str) -> dict[str, Any]:
    points = _run_level_points(reports, surface)
    values = [float(point[estimator]) for point in points]
    first_count = len(values) // 3
    last_start = len(values) - first_count
    latin_blocks = []
    for block_number, (start, end) in enumerate(((0, 7), (7, 14), (14, 21), (21, 24)), start=1):
        block_values = values[start:end]
        latin_blocks.append(
            {
                "block": block_number,
                "admissionRange": [start + 1, end],
                "completeLatinCycle": block_number <= 3,
                "summary": _optional_summary(block_values),
            }
        )
    return {
        "descriptiveSpearmanNoPValue": {
            "attemptNumber": _spearman([float(point["attemptNumber"]) for point in points], values),
            "admissionNumber": _spearman([float(point["admissionNumber"]) for point in points], values),
            "captureTime": _spearman([float(point["capturedAtSeconds"]) for point in points], values),
            "surfaceOrdinal": _spearman([float(point["surfaceOrdinal"]) for point in points], values),
        },
        "firstLastThird": {
            "firstAdmissionRange": [1, first_count],
            "lastAdmissionRange": [last_start + 1, len(values)],
            "first": _optional_summary(values[:first_count]),
            "last": _optional_summary(values[last_start:]),
        },
        "latinSquareBlocks": latin_blocks,
        "telemetry": {
            "availability": "SUPPORTED_BY_SEALED_ATTEMPT_LEDGER",
            "thermalStates": sorted({str(point["thermalState"]) for point in points}),
            "memoryPressureStates": sorted({str(point["memoryPressure"]) for point in points}),
            "descriptiveSpearmanNoPValue": {
                "loadAverage1m": _spearman([float(point["loadAverage1m"]) for point in points], values),
                "freeMemoryBytes": _spearman([float(point["freeMemoryBytes"]) for point in points], values),
            },
        },
    }




def _admission_traceability(reports: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "ledgerSequence": report["ledgerSequence"],
            "attemptId": report["attemptId"],
            "admissionSlotId": report["blockId"],
            "profile": report["profile"],
            "filename": report["filename"],
            "sha256": report["rawReportSha256"],
        }
        for report in sorted(reports, key=lambda item: item["ledgerSequence"])
    ]


def _sufficient_result(
    reports: Sequence[dict[str, Any]],
    prereg: dict[str, Any],
    hashes: dict[str, Any],
    attempts: dict[str, int],
    invalid: dict[str, int],
    attempt_findings: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    by_profile = {profile: [report for report in reports if report["profile"] == profile] for profile in ("short", "soak")}
    platforms = sorted({f"{report['platform']}/{report['arch']}" for report in reports})
    if len(platforms) != 1:
        raise EvidenceError("platform or architecture drift across admitted reports")
    shared_provenance_fields = prereg["cohort"]["sharedRunnerProvenanceFields"]
    provenance_reference = reports[0]["runnerProvenance"]
    for report in reports[1:]:
        for field in shared_provenance_fields:
            if report["runnerProvenance"][field] != provenance_reference[field]:
                raise EvidenceError(f"runner provenance drift across admitted reports: {field}")
    descriptive = {
        profile: {surface: _surface_descriptives(by_profile[profile], surface) for surface in SURFACES}
        for profile in ("short", "soak")
    }
    run_level_points = {
        profile: {surface: _run_level_points(by_profile[profile], surface) for surface in SURFACES}
        for profile in ("short", "soak")
    }
    action_config = prereg["analysis"]["actionFamily"]
    seed = action_config["bootstrap"]["seed"]
    if action_config["bootstrap"]["resamples"] != CANONICAL_RESAMPLES:
        raise EvidenceError("canonical BCa resample count drift")
    sign_minimum = action_config["minimumPositiveSignsPerEstimatorPerSurface"]
    lower_minimum = action_config["minimumBcaLowerBoundBytesPerSecond"]
    action_surfaces: dict[str, Any] = {}
    drift: dict[str, Any] = {}
    all_pass = True
    for surface in ELIGIBLE_SURFACES:
        endpoint = [float(report["baselines"][surface]["baseline"]["heapSlopeBytesPerSecond"]) for report in by_profile["soak"]]
        sensitivity = [float(report["baselines"][surface]["theilSenHeapSlopeBytesPerSecond"]) for report in by_profile["soak"]]
        interval = _bca_interval(endpoint, seed)
        endpoint_positive = sum(value > 0 for value in endpoint)
        sensitivity_positive = sum(value > 0 for value in sensitivity)
        passed = endpoint_positive >= sign_minimum and sensitivity_positive >= sign_minimum and interval["lower"] >= lower_minimum
        all_pass = all_pass and passed
        action_surfaces[surface] = {
            "reportCount": len(endpoint),
            "primarySummaryBytesPerSecond": _summary(endpoint),
            "primaryMedianBytesPerSecond": _median(endpoint),
            "primaryBca": interval,
            "endpointPositiveSigns": endpoint_positive,
            "theilSenSummaryBytesPerSecond": _summary(sensitivity),
            "theilSenMedianBytesPerSecond": _median(sensitivity),
            "theilSenPositiveSigns": sensitivity_positive,
            "minimumPositiveSignsRequired": sign_minimum,
            "minimumBcaLowerBoundBytesPerSecond": lower_minimum,
            "surfacePass": passed,
        }
        drift[surface] = {
            "endpointHeapSlopeBytesPerSecond": _estimator_sensitivities(
                by_profile["soak"], surface, "endpointHeapSlopeBytesPerSecond"
            ),
            "theilSenHeapSlopeBytesPerSecond": _estimator_sensitivities(
                by_profile["soak"], surface, "theilSenHeapSlopeBytesPerSecond"
            ),
        }
    admission = {}
    for profile in ("short", "soak"):
        config = prereg["cohort"]["profiles"][profile]
        admission[profile] = {
            "attemptsObserved": attempts[profile],
            "attemptCap": config["attemptCap"],
            "requiredAdmittedBlocks": config["requiredAdmittedBlocks"],
            "admittedBlocks": len(by_profile[profile]),
            "invalidBlocks": invalid[profile],
            "notEvaluatedBlocks": 0,
            "unusedPreallocatedAttempts": config["attemptCap"] - attempts[profile],
            "excludedBlocks": 0,
            "allMembersAdmitted": len(by_profile[profile]) == config["requiredAdmittedBlocks"],
        }
    p95_receipt = dict(prereg["analysis"]["p95MethodReceipt"])
    p95_receipt.update(
        {
            "status": "OMITTED_IMPOSSIBLE",
            "maximumFiniteUpperCoverage": 1.0 - 0.95**24,
            "empiricalP95Emitted": False,
            "modeledP95Emitted": False,
        }
    )
    return {
        "schema": ANALYSIS_SCHEMA,
        "evidenceStatus": "SUFFICIENT_EVIDENCE",
        "actionDecision": "ACTION" if all_pass else "NO_ACTION",
        "actionFamily": "sustained-heap-growth",
        "hashBindings": hashes,
        "admissionTraceability": _admission_traceability(reports),
        "admission": admission,
        "cohort": {
            "reportSchema": REPORT_SCHEMA,
            "reportCount": len(reports),
            "gitSha": hashes["expectedGitSha"],
            "gitDirty": False,
            "platformArch": platforms[0],
            "allMembersRequired": True,
            "sharedRunnerProvenance": provenance_reference,
        },
        "diagnostics": {
            "validationErrors": list(attempt_findings),
            "schemaDrift": [item for item in attempt_findings if item["category"] == "STRUCTURE"],
            "provenanceDrift": [item for item in attempt_findings if item["category"] == "PROVENANCE"],
            "profileControlDrift": [item for item in attempt_findings if item["code"] == "PROFILE_CONTROL_DRIFT"],
            "surfaceSetDrift": [item for item in attempt_findings if item["code"] == "SURFACE_SET_DRIFT"],
            "surfaceOrderDrift": [item for item in attempt_findings if item["code"] == "SURFACE_ORDER_DRIFT"],
            "platformDrift": [],
            "validatedBlockOrder": [report["blockId"] for report in reports],
            "validatedAttemptOrder": [report["attemptId"] for report in reports],
            "attemptTelemetry": [
                {
                    "attemptId": report["attemptId"],
                    "telemetryBefore": report["captureTelemetry"]["telemetryBefore"],
                    "telemetryAfter": report["captureTelemetry"]["telemetryAfter"],
                }
                for report in reports
            ],
            "driftOrderTimeTelemetrySensitivities": drift,
        },
        "descriptiveByProfileAndSurface": descriptive,
        "runLevelPointsByProfileAndSurface": run_level_points,
        "actionAnalysis": {
            "profile": "soak",
            "metric": "heapSlopeBytesPerSecond",
            "primaryEstimator": "endpoint",
            "sensitivityEstimator": "steady-state-Theil-Sen",
            "aggregation": "all-members median",
            "surfaces": action_surfaces,
            "allConjunctiveConditionsPass": all_pass,
        },
        "claimPolicy": {
            "p95": p95_receipt,
            "otherSurfaces": "DESCRIPTIVE_ONLY",
            "teardownAndExtrema": "DESCRIPTIVE_ONLY",
        },
        "limitations": prereg["limitations"],
    }


def _finding(
    code: str,
    category: str,
    message: str,
    schedule: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {"code": code, "category": category, "message": message}
    if schedule is not None:
        result.update(
            {
                "blockId": schedule.get("slotId"),
                "attemptId": schedule.get("attemptId"),
                "attemptNumber": schedule.get("attemptNumber"),
                "admissionNumber": schedule.get("admissionNumber"),
                "filename": schedule["expectedFilename"],
                "profile": schedule["profile"],
            }
        )
    return result


def _finding_from_error(error: EvidenceError, schedule: dict[str, Any] | None = None) -> dict[str, Any]:
    message = str(error)
    lowered = message.lower()
    if "duplicate json key" in lowered:
        code, category = "DUPLICATE_JSON_KEY", "STRUCTURE"
    elif "depth bound" in lowered:
        code, category = "JSON_DEPTH_BOUND_EXCEEDED", "RESOURCE_BOUND"
    elif "byte bound" in lowered:
        code, category = "BYTE_BOUND_EXCEEDED", "RESOURCE_BOUND"
    elif "sample-count bound" in lowered or "before theil-sen" in lowered:
        code, category = "PERIODIC_SAMPLE_BOUND_EXCEEDED", "RESOURCE_BOUND"
    elif "elapsed-duration tolerance" in lowered:
        code, category = "ELAPSED_DURATION_BOUND_EXCEEDED", "RESOURCE_BOUND"
    elif "near-equal timestamp" in lowered:
        code, category = "TIMESTAMP_SEPARATION_INVALID", "STRUCTURE"
    elif "slope" in lowered:
        code, category = "DERIVED_SLOPE_INVALID", "ESTIMATOR"
    elif "raw private" in lowered or "privacy" in lowered or "sourceclass" in lowered:
        code, category = "PRIVACY_TAXONOMY_INVALID", "PRIVACY"
    elif any(term in lowered for term in ("git", "runtimecommand", "runtimecontrolidentity", "closure", "bun ", "bunexecutable", "worktree", "process identity", "child pid", "parent pid")):
        code, category = "PROVENANCE_DRIFT", "PROVENANCE"
    elif "order" in lowered or "ordinal" in lowered:
        code, category = "SURFACE_ORDER_DRIFT", "CONTROL"
    elif "seven required memory surfaces" in lowered:
        code, category = "SURFACE_SET_DRIFT", "CONTROL"
    elif "profile" in lowered or "duration" in lowered or "iterations" in lowered or "environment" in lowered:
        code, category = "PROFILE_CONTROL_DRIFT", "CONTROL"
    elif "platform" in lowered or "architecture" in lowered:
        code, category = "PLATFORM_DRIFT", "PROVENANCE"
    else:
        code, category = "REPORT_VALIDATION_FAILED", "STRUCTURE"
    return _finding(code, category, message, schedule)


def _insufficient_result(
    findings: Sequence[dict[str, Any]],
    hashes: dict[str, Any],
    prereg: dict[str, Any] | None = None,
    attempts: dict[str, int] | None = None,
    admitted: dict[str, int] | None = None,
    invalid: dict[str, int] | None = None,
    reports: Sequence[dict[str, Any]] = (),
) -> dict[str, Any]:
    attempts = attempts or {"short": 0, "soak": 0}
    admitted = admitted or {"short": 0, "soak": 0}
    invalid = invalid or {"short": 0, "soak": 0}
    limitations = prereg.get("limitations", []) if prereg else []
    admission: dict[str, Any] = {}
    for profile, required in (("short", 5), ("soak", 24)):
        not_evaluated = max(required - admitted[profile] - invalid[profile], 0)
        attempt_cap = prereg["cohort"]["profiles"][profile]["attemptCap"] if prereg else (7 if profile == "short" else 30)
        admission[profile] = {
            "attemptsObserved": attempts[profile],
            "attemptCap": attempt_cap,
            "requiredAdmittedBlocks": required,
            "admittedBlocks": admitted[profile],
            "invalidBlocks": invalid[profile],
            "notEvaluatedBlocks": not_evaluated,
            "unusedPreallocatedAttempts": attempt_cap - attempts[profile],
            "excludedBlocks": 0,
            "allMembersAdmitted": admitted[profile] == required,
        }
    p95_receipt = dict(prereg["analysis"]["p95MethodReceipt"]) if prereg else {
        "method": "two-sided-distribution-free-exact-order-statistic-interval",
        "independentBlockCount": 24,
        "finiteUpperEndpointAvailable": False,
    }
    p95_receipt.update(
        {
            "status": "OMITTED_IMPOSSIBLE",
            "maximumFiniteUpperCoverage": 1.0 - 0.95**24,
            "empiricalP95Emitted": False,
            "modeledP95Emitted": False,
        }
    )
    return {
        "schema": ANALYSIS_SCHEMA,
        "evidenceStatus": "INSUFFICIENT_EVIDENCE",
        "actionDecision": "NOT_EVALUATED",
        "actionFamily": "sustained-heap-growth",
        "hashBindings": hashes,
        "admissionTraceability": _admission_traceability(reports),
        "admission": admission,
        "diagnostics": {
            "validationErrors": list(findings),
            "schemaDrift": [item for item in findings if item["category"] == "STRUCTURE"],
            "provenanceDrift": [item for item in findings if item["category"] == "PROVENANCE"],
            "profileControlDrift": [item for item in findings if item["code"] == "PROFILE_CONTROL_DRIFT"],
            "surfaceSetDrift": [item for item in findings if item["code"] == "SURFACE_SET_DRIFT"],
            "surfaceOrderDrift": [item for item in findings if item["code"] == "SURFACE_ORDER_DRIFT"],
            "platformDrift": [item for item in findings if item["code"] == "PLATFORM_DRIFT"],
            "resourceBounds": [item for item in findings if item["category"] == "RESOURCE_BOUND"],
            "privacyDrift": [item for item in findings if item["category"] == "PRIVACY"],
        },
        "claimPolicy": {"p95": p95_receipt, "otherSurfaces": "DESCRIPTIVE_ONLY", "teardownAndExtrema": "DESCRIPTIVE_ONLY"},
        "limitations": limitations,
    }


def _markdown(result: dict[str, Any]) -> str:
    lines = [
        "# Sealed perf-corpus memory analysis",
        "",
        f"- Evidence status: `{result['evidenceStatus']}`",
        f"- Action decision: `{result['actionDecision']}`",
        "- Action family: `sustained-heap-growth`",
        "- Tail-percentile claim: omitted",
        "",
    ]
    bindings = result["hashBindings"]
    lines.extend(
        [
            "## Sealed input bindings",
            "",
            f"- Authenticated attempt ledger SHA-256: `{bindings['attemptLedgerSha256']}`",
            f"- Authenticated raw manifest SHA-256: `{bindings['rawManifestSha256']}`",
            "",
            "### Admitted raw report traceability",
            "",
            "| Ledger sequence | Attempt | Admission slot | Profile | Filename | SHA-256 |",
            "| ---: | --- | --- | --- | --- | --- |",
        ]
    )
    for item in result["admissionTraceability"]:
        lines.append(
            f"| {item['ledgerSequence']} | {item['attemptId']} | {item['admissionSlotId']} | "
            f"{item['profile']} | {item['filename']} | `{item['sha256']}` |"
        )
    lines.append("")
    if result["evidenceStatus"] == "SUFFICIENT_EVIDENCE":
        lines.extend([
            "## Admission",
            "",
            "| Profile | Admitted / required | Attempts / cap |",
            "| --- | ---: | ---: |",
        ])
        for profile in ("short", "soak"):
            item = result["admission"][profile]
            lines.append(f"| {profile} | {item['admittedBlocks']} / {item['requiredAdmittedBlocks']} | {item['attemptsObserved']} / {item['attemptCap']} |")
        lines.extend(["", "## Preregistered action rule", "", "| Surface | Endpoint median (B/s) | BCa lower (B/s) | Endpoint + | Theil–Sen + | Pass |", "| --- | ---: | ---: | ---: | ---: | --- |"])
        for surface in ELIGIBLE_SURFACES:
            item = result["actionAnalysis"]["surfaces"][surface]
            lines.append(f"| {surface} | {item['primaryMedianBytesPerSecond']:.6f} | {item['primaryBca']['lower']:.6f} | {item['endpointPositiveSigns']} | {item['theilSenPositiveSigns']} | {str(item['surfacePass']).lower()} |")
        lines.extend(["", "All seven surfaces, teardown values, observed extrema, sampling counters, and endpoint/sensitivity slopes are retained in the canonical JSON as descriptive summaries.", ""])
    else:
        lines.extend(["## Admission failure", ""])
        for error in result["diagnostics"]["validationErrors"]:
            location = f" ({error['filename']})" if "filename" in error else ""
            lines.append(f"- [{error['category']}/{error['code']}]{location} {error['message']}")
        lines.append("")
    lines.extend(["## Limitations", ""])
    for limitation in result.get("limitations", []):
        lines.append(f"- {limitation}")
    return "\n".join(lines) + "\n"


def _validate_sealed_inputs(
    input_dir: Path,
    prereg: dict[str, Any],
    expected_bindings: dict[str, str],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], dict[str, bytes], dict[str, Any], dict[str, os.stat_result]]:
    contract = prereg["sealedInputContract"]
    ledger_raw, ledger_info = _read_file_bytes(input_dir / ATTEMPT_LEDGER_FILENAME, contract["maximumLedgerBytes"])
    manifest_raw, manifest_info = _read_file_bytes(input_dir / RAW_MANIFEST_FILENAME, contract["maximumManifestBytes"])
    ledger_digest = _sha256_bytes(ledger_raw)
    manifest_digest = _sha256_bytes(manifest_raw)
    if ledger_digest != expected_bindings["attemptLedgerSha256"]:
        raise EvidenceError("attempt ledger SHA-256 mismatch for supplied bytes")
    if manifest_digest != expected_bindings["rawManifestSha256"]:
        raise EvidenceError("raw manifest SHA-256 mismatch for supplied bytes")
    ledger = _expect_dict(
        _load_json_bytes(
            ledger_raw,
            ATTEMPT_LEDGER_FILENAME,
            contract["maximumLedgerBytes"],
            prereg["bounds"]["maximumJsonDepth"],
        ),
        ATTEMPT_LEDGER_FILENAME,
    )
    manifest = _expect_dict(
        _load_json_bytes(
            manifest_raw,
            RAW_MANIFEST_FILENAME,
            contract["maximumManifestBytes"],
            prereg["bounds"]["maximumJsonDepth"],
        ),
        RAW_MANIFEST_FILENAME,
    )
    _expect_exact_keys(ledger, set(contract["ledgerFields"]), ATTEMPT_LEDGER_FILENAME)
    if (
        ledger.get("schema") != ATTEMPT_LEDGER_SCHEMA
        or ledger.get("version") != contract["attemptLedgerVersion"]
        or ledger.get("complete") is not True
    ):
        raise EvidenceError("attempt ledger schema/version/complete drift")
    _validate_seal(ledger, ATTEMPT_LEDGER_FILENAME)
    _expect_sha256(ledger.get("captureId"), f"{ATTEMPT_LEDGER_FILENAME}.captureId")
    _expect_git_oid(ledger.get("measurementGitSha"), f"{ATTEMPT_LEDGER_FILENAME}.measurementGitSha")
    _expect_git_oid(ledger.get("measurementTreeSha"), f"{ATTEMPT_LEDGER_FILENAME}.measurementTreeSha")
    for field in (
        "closureDigest",
        "worktreeFingerprint",
        "runtimeControlIdentity",
        "scheduleDigest",
        "protocolDigest",
    ):
        _expect_sha256(ledger.get(field), f"{ATTEMPT_LEDGER_FILENAME}.{field}")
    identity_fields = {
        "captureId": "expectedCaptureId",
        "measurementGitSha": "expectedGitSha",
        "measurementTreeSha": "expectedTreeSha",
        "closureDigest": "expectedClosureDigest",
        "worktreeFingerprint": "expectedWorktreeFingerprint",
        "runtimeControlIdentity": "expectedRuntimeControlIdentity",
        "scheduleDigest": "expectedScheduleDigest",
        "protocolDigest": "expectedProtocolDigest",
    }
    for field, expected_field in identity_fields.items():
        if ledger.get(field) != expected_bindings[expected_field]:
            raise EvidenceError(f"attempt ledger authenticated binding mismatch: {field}")
    derived_schedule_digest = _canonical_digest(prereg["captureControls"]["schedule"])
    if ledger["scheduleDigest"] != derived_schedule_digest:
        raise EvidenceError("attempt ledger frozen schedule digest mismatch")
    if ledger["protocolDigest"] != _protocol_digest(prereg):
        raise EvidenceError("attempt ledger frozen protocol digest mismatch")

    host = _expect_dict(ledger.get("host"), f"{ATTEMPT_LEDGER_FILENAME}.host")
    _expect_exact_keys(host, set(contract["hostFields"]), f"{ATTEMPT_LEDGER_FILENAME}.host")
    _expect_sha256(host.get("hostId"), f"{ATTEMPT_LEDGER_FILENAME}.host.hostId")
    _expect_string(host.get("platform"), f"{ATTEMPT_LEDGER_FILENAME}.host.platform")
    _expect_string(host.get("arch"), f"{ATTEMPT_LEDGER_FILENAME}.host.arch")
    if host.get("powerSource") != contract["requiredPowerSource"] or host.get("powerMode") != contract["requiredPowerMode"]:
        raise EvidenceError("attempt ledger fixed host power state drift")

    def validate_telemetry(value: Any, label: str, minimum_time: float, maximum_time: float) -> tuple[float, int]:
        telemetry = _expect_dict(value, label)
        _expect_exact_keys(telemetry, set(contract["telemetryFields"]), label)
        observed_time = _timestamp_seconds(telemetry.get("timestamp"), f"{label}.timestamp")
        if observed_time < minimum_time or observed_time > maximum_time:
            raise EvidenceError(f"{label}.timestamp is outside the attempt boundary")
        validated: dict[str, float | int | str] = {}
        for field in ("thermalState", "memoryPressure", "loadAverage1m", "freeMemoryBytes"):
            metric_label = f"{label}.{field}"
            metric = _expect_dict(telemetry.get(field), metric_label)
            _expect_exact_keys(metric, set(contract["telemetryValueFields"]), metric_label)
            if metric.get("availability") not in contract["telemetryAvailabilityValues"]:
                raise EvidenceError(f"{metric_label}.availability is invalid")
            if metric.get("availability") != contract["requiredTelemetryAvailability"]:
                raise EvidenceError(f"{metric_label} required telemetry is unavailable")
            validated[field] = metric.get("value")
        if validated["thermalState"] not in contract["allowedThermalStates"]:
            raise EvidenceError(f"{label}.thermalState is critical or outside the frozen control")
        if validated["memoryPressure"] not in contract["allowedMemoryPressureStates"]:
            raise EvidenceError(f"{label}.memoryPressure is critical or outside the frozen control")
        load = _expect_number(validated["loadAverage1m"], f"{label}.loadAverage1m.value", nonnegative=True)
        if load > contract["maximumLoadAverage1m"]:
            raise EvidenceError(f"{label}.loadAverage1m exceeds bound")
        free_memory = _expect_integer(validated["freeMemoryBytes"], f"{label}.freeMemoryBytes.value", positive=True)
        if not contract["minimumFreeMemoryBytes"] <= free_memory <= contract["maximumFreeMemoryBytes"]:
            raise EvidenceError(f"{label}.freeMemoryBytes exceeds bound")
        return load, free_memory

    attempts = _expect_list(ledger.get("attempts"), f"{ATTEMPT_LEDGER_FILENAME}.attempts")
    if not attempts or len(attempts) > 37:
        raise EvidenceError("attempt ledger attempt count is outside frozen bounds")
    schedule_by_id = {
        item["attemptId"]: (index, item)
        for index, item in enumerate(prereg["captureControls"]["schedule"])
    }
    previous_schedule_index = -1
    previous_end = 0.0
    first_before_load: float | None = None
    first_free_memory: int | None = None
    validated_attempts: list[dict[str, Any]] = []
    filenames: set[str] = set()
    for index, raw_attempt in enumerate(attempts):
        label = f"{ATTEMPT_LEDGER_FILENAME}.attempts[{index}]"
        attempt = _expect_dict(raw_attempt, label)
        _expect_exact_keys(attempt, set(contract["attemptFields"]), label)
        if _expect_integer(attempt.get("sequence"), f"{label}.sequence", positive=True) != index + 1:
            raise EvidenceError("attempt ledger global sequence drift")
        attempt_id = _expect_string(attempt.get("attemptId"), f"{label}.attemptId")
        if attempt_id not in schedule_by_id:
            raise EvidenceError(f"{label}.attemptId is outside frozen allocation")
        schedule_index, scheduled = schedule_by_id[attempt_id]
        if schedule_index <= previous_schedule_index:
            raise EvidenceError("attempt ledger global chronological interleaving drift")
        previous_schedule_index = schedule_index
        for field in ("profile", "attemptNumber"):
            if attempt.get(field) != scheduled[field]:
                raise EvidenceError(f"{label}.{field} allocation drift")
        if attempt.get("reportFilename") != scheduled["expectedFilename"] or attempt["reportFilename"] in filenames:
            raise EvidenceError(f"{label}.reportFilename allocation or uniqueness drift")
        filenames.add(attempt["reportFilename"])
        slot_id = _expect_string(attempt.get("admissionSlotId"), f"{label}.admissionSlotId")
        rows = prereg["captureControls"]["admissionRows"][scheduled["profile"]]
        matching_rows = [row for row in rows if row["slotId"] == slot_id]
        if len(matching_rows) != 1 or attempt.get("expectedSurfaceOrder") != matching_rows[0]["surfaceOrder"]:
            raise EvidenceError(f"{label} replacement slot/expected surface order drift")
        actual_order = _validate_string_array(attempt.get("actualSurfaceOrder"), f"{label}.actualSurfaceOrder")
        if len(actual_order) != len(SURFACES) or set(actual_order) != set(SURFACES):
            raise EvidenceError(f"{label}.actualSurfaceOrder must be the exact seven-surface permutation")

        started = _timestamp_seconds(attempt.get("startedAt"), f"{label}.startedAt")
        ended = _timestamp_seconds(attempt.get("endedAt"), f"{label}.endedAt")
        if ended <= started:
            raise EvidenceError(f"{label} has an overlapping or non-positive interval")
        if attempt.get("sequential") is not True:
            raise EvidenceError(f"{label}.sequential must be true")
        cooldown = _expect_number(
            attempt.get("cooldownAfterPreviousSeconds"),
            f"{label}.cooldownAfterPreviousSeconds",
            nonnegative=True,
        )
        if index == 0:
            if cooldown != 0:
                raise EvidenceError("first attempt cooldown must be zero")
        else:
            actual_cooldown = started - previous_end
            if (
                started < previous_end
                or actual_cooldown < contract["minimumCooldownSeconds"]
                or abs(cooldown - actual_cooldown) > 0.001
            ):
                raise EvidenceError(f"{label} overlaps or violates sequential 60-second cooldown")
        previous_end = ended
        for field in ("hostId", "platform", "arch", "powerSource", "powerMode"):
            if attempt.get(field) != host[field]:
                raise EvidenceError(f"{label}.{field} fixed host/power state drift")
        before_load, before_free = validate_telemetry(attempt.get("telemetryBefore"), f"{label}.telemetryBefore", started, ended)
        _, after_free = validate_telemetry(attempt.get("telemetryAfter"), f"{label}.telemetryAfter", started, ended)
        if first_before_load is None:
            first_before_load = before_load
            first_free_memory = before_free
        elif Decimal(str(before_load)) - Decimal(str(first_before_load)) > Decimal(
            str(contract["maximumLoadAverage1mDrift"])
        ):
            raise EvidenceError(f"{label}.telemetryBefore.loadAverage1m ambient drift")
        if first_free_memory is None:
            raise EvidenceError("attempt ledger free-memory reference is missing")
        for free_memory in (before_free, after_free):
            if abs(free_memory - first_free_memory) / first_free_memory > contract["maximumFreeMemoryFractionDrift"]:
                raise EvidenceError(f"{label}.freeMemoryBytes telemetry drift")
        if attempt.get("interrupted") is not False:
            raise EvidenceError(f"{label}.interrupted must be false")
        if attempt.get("parentClosed") is not True or attempt.get("childrenClosed") is not True:
            raise EvidenceError(f"{label} parent/children process closure failed")
        _expect_integer(attempt.get("reportSizeBytes"), f"{label}.reportSizeBytes", positive=True)
        _expect_sha256(attempt.get("reportSha256"), f"{label}.reportSha256")
        _expect_git_oid(attempt.get("measurementGitSha"), f"{label}.measurementGitSha")
        _expect_git_oid(attempt.get("measurementTreeSha"), f"{label}.measurementTreeSha")
        for field in ("closureDigest", "worktreeFingerprint", "runtimeControlIdentity"):
            _expect_sha256(attempt.get(field), f"{label}.{field}")
        for field, expected_field in (
            ("measurementGitSha", "expectedGitSha"),
            ("measurementTreeSha", "expectedTreeSha"),
            ("closureDigest", "expectedClosureDigest"),
            ("worktreeFingerprint", "expectedWorktreeFingerprint"),
        ):
            if attempt[field] != expected_bindings[expected_field]:
                raise EvidenceError(f"{label} authenticated M/tree/C/fingerprint binding drift: {field}")
        validated_attempts.append(attempt)

    sealed_at = _timestamp_seconds(ledger.get("sealedAt"), f"{ATTEMPT_LEDGER_FILENAME}.sealedAt")
    if sealed_at < previous_end:
        raise EvidenceError("attempt ledger was sealed before the final attempt ended")

    _expect_exact_keys(manifest, set(contract["manifestFields"]), RAW_MANIFEST_FILENAME)
    if (
        manifest.get("schema") != RAW_MANIFEST_SCHEMA
        or manifest.get("version") != contract["rawManifestVersion"]
        or manifest.get("complete") is not True
    ):
        raise EvidenceError("raw manifest schema/version/complete drift")
    _validate_seal(manifest, RAW_MANIFEST_FILENAME)
    if manifest.get("sealedAt") != ledger.get("sealedAt"):
        raise EvidenceError("raw manifest sealed timestamp mismatch")
    for field, expected_field in identity_fields.items():
        if manifest.get(field) != expected_bindings[expected_field]:
            raise EvidenceError(f"raw manifest authenticated binding mismatch: {field}")
    manifest_ledger = _expect_dict(manifest.get("ledger"), f"{RAW_MANIFEST_FILENAME}.ledger")
    _expect_exact_keys(manifest_ledger, set(contract["manifestLedgerFields"]), f"{RAW_MANIFEST_FILENAME}.ledger")
    if manifest_ledger != {
        "filename": ATTEMPT_LEDGER_FILENAME,
        "sizeBytes": ledger_info.st_size,
        "sha256": ledger_digest,
    }:
        raise EvidenceError("raw manifest attempt-ledger binding mismatch")
    manifest_reports = _expect_list(manifest.get("reports"), f"{RAW_MANIFEST_FILENAME}.reports")
    if len(manifest_reports) != len(validated_attempts):
        raise EvidenceError("raw manifest is incomplete for attempt ledger")
    bindings: dict[str, dict[str, Any]] = {}
    ordered_report_hashes: list[dict[str, Any]] = []
    authenticated_report_bytes: dict[str, bytes] = {}
    authenticated_file_stats: dict[str, os.stat_result] = {
        ATTEMPT_LEDGER_FILENAME: ledger_info,
        RAW_MANIFEST_FILENAME: manifest_info,
    }
    for index, (raw_entry, attempt) in enumerate(zip(manifest_reports, validated_attempts)):
        label = f"{RAW_MANIFEST_FILENAME}.reports[{index}]"
        entry = _expect_dict(raw_entry, label)
        _expect_exact_keys(entry, set(contract["manifestReportFields"]), label)
        expected = {
            "sequence": index + 1,
            "attemptId": attempt["attemptId"],
            "filename": attempt["reportFilename"],
            "sizeBytes": attempt["reportSizeBytes"],
            "sha256": attempt["reportSha256"],
        }
        if entry != expected:
            raise EvidenceError(f"{label} report binding mismatch")
        if entry["filename"] in bindings:
            raise EvidenceError(f"{label} duplicate report filename")
        bindings[entry["filename"]] = entry
        ordered_report_hashes.append(
            {
                "sequence": entry["sequence"],
                "attemptId": entry["attemptId"],
                "admissionSlotId": attempt["admissionSlotId"],
                "profile": attempt["profile"],
                "filename": entry["filename"],
                "sha256": entry["sha256"],
            }
        )
    for filename, binding in bindings.items():
        report_raw, report_info = _read_file_bytes(input_dir / filename, prereg["bounds"]["maximumBytesPerFile"])
        if len(report_raw) != binding["sizeBytes"] or _sha256_bytes(report_raw) != binding["sha256"]:
            raise EvidenceError(f"{filename}: report filename/size/SHA-256 binding mismatch")
        authenticated_report_bytes[filename] = report_raw
        authenticated_file_stats[filename] = report_info
    return validated_attempts, bindings, authenticated_report_bytes, {
        "attemptLedgerSha256": ledger_digest,
        "rawManifestSha256": manifest_digest,
        "orderedReportHashes": ordered_report_hashes,
    }, authenticated_file_stats

def _safe_directory(path: Path, *, create: bool = False) -> Path:
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise EvidenceError(f"directory path is not a real directory: {path}")
    elif create:
        path.mkdir(parents=True, exist_ok=False)
    else:
        raise EvidenceError(f"directory does not exist: {path}")
    return path.resolve(strict=True)


def _write_canonical(output_dir: Path, result: dict[str, Any], maximum_markdown_bytes: int) -> tuple[Path, Path]:
    json_text = json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2, sort_keys=True, separators=(",", ": ")) + "\n"
    markdown = _markdown(result)
    if len(markdown.encode("utf-8")) > maximum_markdown_bytes:
        raise EvidenceError("Markdown output exceeds preregistered byte bound")
    outputs = ((RESULT_JSON, json_text), (RESULT_MARKDOWN, markdown))
    for filename, text in outputs:
        destination = output_dir / filename
        if destination.is_symlink() or (destination.exists() and not destination.is_file()):
            raise EvidenceError(f"unsafe output path: {filename}")
        temporary = output_dir / f".{filename}.tmp"
        if temporary.exists() or temporary.is_symlink():
            raise EvidenceError(f"stale output temporary path: {temporary.name}")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(temporary, flags, 0o600)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, destination)
        finally:
            if temporary.exists():
                temporary.unlink()
    return output_dir / RESULT_JSON, output_dir / RESULT_MARKDOWN


def run_analysis(
    input_dir: str | os.PathLike[str],
    output_dir: str | os.PathLike[str],
    preregistration_bytes: bytes,
    expected_git_sha: str,
    expected_tree_sha: str,
    expected_closure_digest: str,
    expected_worktree_fingerprint: str,
    expected_runtime_control_identity: str,
    expected_capture_id: str,
    expected_schedule_digest: str,
    expected_protocol_digest: str,
    authenticated_driver_sha256: str,
    authenticated_preregistration_sha256: str,
    authenticated_template_sha256: str,
    authenticated_attempt_ledger_sha256: str,
    authenticated_raw_manifest_sha256: str,
) -> dict[str, Any]:
    for expected, label in ((expected_git_sha, "git SHA"), (expected_tree_sha, "tree SHA")):
        if (
            not isinstance(expected, str)
            or len(expected) != 40
            or any(character not in "0123456789abcdefABCDEF" for character in expected)
        ):
            raise EvidenceError(f"expected {label} must be 40 hexadecimal characters")
    digest_inputs = (
        (expected_closure_digest, "closure digest"),
        (expected_worktree_fingerprint, "worktree fingerprint"),
        (expected_runtime_control_identity, "runtime control identity"),
        (expected_capture_id, "capture ID"),
        (expected_schedule_digest, "schedule digest"),
        (expected_protocol_digest, "protocol digest"),
        (authenticated_driver_sha256, "driver"),
        (authenticated_preregistration_sha256, "preregistration"),
        (authenticated_template_sha256, "template"),
        (authenticated_attempt_ledger_sha256, "attempt ledger"),
        (authenticated_raw_manifest_sha256, "raw manifest"),
    )
    for expected, label in digest_inputs:
        if (
            not isinstance(expected, str)
            or len(expected) != 64
            or any(character not in "0123456789abcdefABCDEF" for character in expected)
        ):
            raise EvidenceError(f"authenticated {label} SHA-256 is invalid")
    if _sha256_bytes(preregistration_bytes) != authenticated_preregistration_sha256.lower():
        raise EvidenceError("preregistration SHA-256 mismatch for supplied bytes")
    prereg_raw = _load_json_bytes(preregistration_bytes, "perf-corpus-preregistration.json", 1024 * 1024, 40)
    prereg = _validate_preregistration(prereg_raw)
    input_real = _safe_directory(Path(input_dir))
    output_real = _safe_directory(Path(output_dir), create=True)
    if input_real == output_real or input_real in output_real.parents or output_real in input_real.parents:
        raise EvidenceError("input and output directories must be disjoint")
    expected_bindings = {
        "expectedGitSha": expected_git_sha.lower(),
        "expectedTreeSha": expected_tree_sha.lower(),
        "expectedClosureDigest": expected_closure_digest.lower(),
        "expectedWorktreeFingerprint": expected_worktree_fingerprint.lower(),
        "expectedRuntimeControlIdentity": expected_runtime_control_identity.lower(),
        "expectedCaptureId": expected_capture_id.lower(),
        "expectedScheduleDigest": expected_schedule_digest.lower(),
        "expectedProtocolDigest": expected_protocol_digest.lower(),
        "attemptLedgerSha256": authenticated_attempt_ledger_sha256.lower(),
        "rawManifestSha256": authenticated_raw_manifest_sha256.lower(),
    }
    hashes: dict[str, Any] = {
        "driverSha256": authenticated_driver_sha256.lower(),
        "preregistrationSha256": authenticated_preregistration_sha256.lower(),
        "templateSha256": authenticated_template_sha256.lower(),
        **expected_bindings,
    }
    bounds = prereg["bounds"]
    try:
        (
            ledger_attempts,
            raw_bindings,
            authenticated_report_bytes,
            sealed_hashes,
            authenticated_file_stats,
        ) = _validate_sealed_inputs(input_real, prereg, expected_bindings)
        hashes.update(sealed_hashes)
    except (EvidenceError, FileNotFoundError) as error:
        finding = _finding(
            "SEALED_INPUT_INVALID",
            "PROTOCOL",
            str(error) if isinstance(error, EvidenceError) else f"missing sealed input: {Path(error.filename).name}",
        )
        result = _insufficient_result([finding], hashes, prereg)
        json_path, markdown_path = _write_canonical(output_real, result, bounds["maximumMarkdownBytes"])
        return {"result": result, "resultJsonPath": str(json_path), "resultMarkdownPath": str(markdown_path)}
    frozen_schedule = prereg["captureControls"]["schedule"]
    schedule_by_id = {item["attemptId"]: item for item in frozen_schedule}
    schedule_items = [schedule_by_id[item["attemptId"]] for item in ledger_attempts]
    ledger_by_filename = {item["reportFilename"]: item for item in ledger_attempts}
    admission_rows = prereg["captureControls"]["admissionRows"]
    expected_names = {
        ATTEMPT_LEDGER_FILENAME,
        RAW_MANIFEST_FILENAME,
        *(item["expectedFilename"] for item in schedule_items),
    }
    attempts = {"short": 0, "soak": 0}
    admitted = {"short": 0, "soak": 0}
    invalid = {"short": 0, "soak": 0}
    global_findings: list[dict[str, Any]] = []
    attempt_findings: list[dict[str, Any]] = []
    reports: list[dict[str, Any]] = []

    scanned_entries: list[os.DirEntry[str]] = []
    entry_count_exceeded = False
    with os.scandir(input_real) as iterator:
        for entry in iterator:
            if len(scanned_entries) >= bounds["maximumInputFiles"]:
                entry_count_exceeded = True
                break
            scanned_entries.append(entry)
    if entry_count_exceeded:
        global_findings.append(
            _finding("INPUT_FILE_COUNT_BOUND_EXCEEDED", "RESOURCE_BOUND", "input directory exceeds file-count bound")
        )
    scanned_total_size = 0
    present_names: set[str] = set()
    entry_info: dict[str, os.stat_result] = {}
    for entry in sorted(scanned_entries, key=lambda item: item.name):
        try:
            info = entry.stat(follow_symlinks=False)
            scanned_total_size += info.st_size
            entry_info[entry.name] = info
        except OSError as error:
            global_findings.append(
                _finding(
                    "INPUT_METADATA_UNAVAILABLE",
                    "STRUCTURE",
                    f"cannot stat input directory entry {entry.name}: {error.strerror}",
                )
            )
            continue
        present_names.add(entry.name)
        authenticated_info = authenticated_file_stats.get(entry.name)
        if authenticated_info is not None and (
            info.st_dev,
            info.st_ino,
            info.st_size,
            info.st_mtime_ns,
            info.st_ctime_ns,
        ) != (
            authenticated_info.st_dev,
            authenticated_info.st_ino,
            authenticated_info.st_size,
            authenticated_info.st_mtime_ns,
            authenticated_info.st_ctime_ns,
        ):
            global_findings.append(
                _finding(
                    "AUTHENTICATED_INPUT_METADATA_DRIFT",
                    "PROTOCOL",
                    f"authenticated input changed after byte capture: {entry.name}",
                )
            )
        if entry.name not in expected_names or not entry.name.endswith(".json"):
            global_findings.append(
                _finding(
                    "UNEXPECTED_INPUT_ENTRY",
                    "STRUCTURE",
                    f"unexpected input directory entry: {entry.name}",
                )
            )

    for filename in sorted(authenticated_file_stats):
        if filename not in entry_info:
            global_findings.append(
                _finding(
                    "AUTHENTICATED_INPUT_METADATA_DRIFT",
                    "PROTOCOL",
                    f"authenticated input disappeared after byte capture: {filename}",
                )
            )

    for profile in ("short", "soak"):
        present_numbers = sorted(
            item["attemptNumber"]
            for item in schedule_items
            if item["profile"] == profile and item["expectedFilename"] in present_names
        )
        if present_numbers and present_numbers != list(range(1, present_numbers[-1] + 1)):
            global_findings.append(
                _finding(
                    "MISSING_ATTEMPT_ALLOCATION",
                    "PROTOCOL",
                    f"{profile} attempt files must be a contiguous prefix of the frozen allocation",
                )
            )

    if scanned_total_size > bounds["maximumTotalInputBytes"]:
        global_findings.append(
            _finding("TOTAL_INPUT_BYTE_BOUND_EXCEEDED", "RESOURCE_BOUND", "input directory exceeds total-byte bound")
        )
    else:
        for frozen_item in schedule_items:
            filename = frozen_item["expectedFilename"]
            if filename not in present_names:
                continue
            profile = frozen_item["profile"]
            attempts[profile] += 1
            if admitted[profile] >= prereg["cohort"]["profiles"][profile]["requiredAdmittedBlocks"]:
                global_findings.append(
                    _finding(
                        "POST_TARGET_ATTEMPT",
                        "PROTOCOL",
                        f"{filename} was captured after the {profile} admission target was reached",
                        frozen_item,
                    )
                )
                continue
            row = admission_rows[profile][admitted[profile]]
            schedule = {
                **frozen_item,
                "slotId": row["slotId"],
                "admissionNumber": admitted[profile] + 1,
                "surfaceOrder": row["surfaceOrder"],
            }
            try:
                ledger_attempt = ledger_by_filename[filename]
                binding = raw_bindings[filename]
                if ledger_attempt["admissionSlotId"] != row["slotId"]:
                    raise EvidenceError(f"{filename}: admission slot replacement progression drift")
                report_raw = authenticated_report_bytes[filename]
                report_digest = binding["sha256"]
                report_value = _load_json_bytes(
                    report_raw,
                    filename,
                    bounds["maximumBytesPerFile"],
                    bounds["maximumJsonDepth"],
                )
                report_mapping = _expect_dict(report_value, filename)
                report_runner = _expect_dict(report_mapping.get("runner"), f"{filename}.runner")
                if report_runner.get("memorySurfaceOrder") != ledger_attempt["actualSurfaceOrder"]:
                    raise EvidenceError(f"{filename}: ledger actual surface order binding mismatch")
                for field in ("platform", "arch"):
                    if report_runner.get(field) != ledger_attempt[field]:
                        raise EvidenceError(f"{filename}: report/ledger host {field} binding mismatch")
                for report_field, ledger_field in (
                    ("closureDigest", "closureDigest"),
                    ("worktreeFingerprint", "worktreeFingerprint"),
                    ("runtimeControlIdentity", "runtimeControlIdentity"),
                ):
                    if report_runner.get(report_field) != ledger_attempt[ledger_field]:
                        raise EvidenceError(f"{filename}: report/ledger {report_field} binding mismatch")
                validated_report = _validate_report(report_value, schedule, prereg, expected_git_sha.lower())
                validated_report["ledgerSequence"] = ledger_attempt["sequence"]
                validated_report["rawReportSha256"] = report_digest
                validated_report["captureTelemetry"] = {
                    "telemetryBefore": ledger_attempt["telemetryBefore"],
                    "telemetryAfter": ledger_attempt["telemetryAfter"],
                }
                reports.append(validated_report)
                admitted[profile] += 1
            except EvidenceError as error:
                attempt_findings.append(_finding_from_error(error, schedule))
                invalid[profile] += 1

    for profile in ("short", "soak"):
        required = prereg["cohort"]["profiles"][profile]["requiredAdmittedBlocks"]
        if admitted[profile] != required:
            missing_item = next(
                (
                    item
                    for item in schedule_items
                    if item["profile"] == profile and item["expectedFilename"] not in present_names
                ),
                None,
            )
            if missing_item is not None:
                row = admission_rows[profile][admitted[profile]]
                global_findings.append(
                    _finding(
                        "MISSING_SCHEDULED_BLOCK",
                        "PROTOCOL",
                        f"{missing_item['expectedFilename']} is the next frozen attempt required for {row['slotId']}",
                        {
                            **missing_item,
                            "slotId": row["slotId"],
                            "admissionNumber": admitted[profile] + 1,
                        },
                    )
                )
            global_findings.append(
                _finding(
                    "ADMISSION_TARGET_NOT_MET",
                    "PROTOCOL",
                    f"{profile} admitted {admitted[profile]} of {required} required blocks in {attempts[profile]} attempts",
                )
            )
    all_findings = [*global_findings, *attempt_findings]
    if global_findings:
        result = _insufficient_result(all_findings, hashes, prereg, attempts, admitted, invalid, reports)
    else:
        try:
            result = _sufficient_result(reports, prereg, hashes, attempts, invalid, attempt_findings)
        except EvidenceError as error:
            all_findings.append(_finding_from_error(error))
            result = _insufficient_result(all_findings, hashes, prereg, attempts, admitted, invalid, reports)
    json_path, markdown_path = _write_canonical(output_real, result, bounds["maximumMarkdownBytes"])
    return {"result": result, "resultJsonPath": str(json_path), "resultMarkdownPath": str(markdown_path)}
