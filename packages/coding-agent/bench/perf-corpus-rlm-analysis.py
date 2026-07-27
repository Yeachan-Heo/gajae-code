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
RESULT_JSON = "perf-corpus-rlm-result.json"
RESULT_MARKDOWN = "perf-corpus-rlm-result.md"
NORMAL = NormalDist()
MAX_SAFE_INTEGER = 9_007_199_254_740_991
CANONICAL_RESAMPLES = 10_000


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


def _load_json_file(path: Path, maximum_bytes: int, maximum_depth: int) -> Any:
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
        or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
        != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
        or len(raw) != before.st_size
    ):
        raise EvidenceError(f"file changed while reading: {path.name}")
    return _load_json_bytes(bytes(raw), path.name, maximum_bytes, maximum_depth)


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


def _validate_report(value: Any, schedule: dict[str, Any], prereg: dict[str, Any], expected_git_sha: str) -> dict[str, Any]:
    filename = schedule["expectedFilename"]
    report = _expect_dict(value, filename)
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
    argv = _expect_list(runner.get("argv"), f"{filename}.runner.argv")
    if not argv or any(not isinstance(item, str) or not item for item in argv):
        raise EvidenceError(f"{filename}: runner.argv is invalid")
    platform = _expect_string(runner.get("platform"), f"{filename}.runner.platform")
    arch = _expect_string(runner.get("arch"), f"{filename}.runner.arch")
    if runner.get("bunVersion") != BUN_VERSION:
        raise EvidenceError(f"{filename}: Bun version drift")
    bun_executable = _expect_string(runner.get("bunExecutable"), f"{filename}.runner.bunExecutable")
    if not os.path.isabs(bun_executable) or os.path.normpath(bun_executable) != bun_executable:
        raise EvidenceError(f"{filename}: bunExecutable must be a canonical absolute path")
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
    _expect_list(report.get("hotspotClassifications"), f"{filename}.hotspotClassifications")
    _expect_list(report.get("thresholdLedger"), f"{filename}.thresholdLedger")
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
        tags = _expect_list(fixture.get("workloadTags"), f"{fixture_label}.workloadTags")
        if any(not isinstance(tag, str) or not tag for tag in tags):
            raise EvidenceError(f"{fixture_label}.workloadTags is invalid")
        privacy = _expect_dict(fixture.get("privacy"), f"{fixture_label}.privacy")
        _expect_exact_keys(privacy, {"rawPrivateTranscriptCommitted", "redactionNotes"}, f"{fixture_label}.privacy")
        if privacy.get("rawPrivateTranscriptCommitted") is not False:
            raise EvidenceError(f"{fixture_label}: raw private transcript content is forbidden")
        _expect_string(privacy.get("redactionNotes"), f"{fixture_label}.privacy.redactionNotes")
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
    bounds = _expect_dict(prereg.get("bounds"), "preregistration.bounds")
    expected_bounds = {
        "maximumInputFiles": 37,
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
        or "cyclic rotations" not in str(permutation.get("algorithm", ""))
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
        action.get("eligibleSurfaces") != list(ELIGIBLE_SURFACES)
        or action.get("eligibleProfile") != "soak"
        or action.get("primaryEstimator") != "report-endpoint-heapSlopeBytesPerSecond"
        or action.get("sensitivityEstimator") != "per-report-steady-state-Theil-Sen-heapUsedBytes-slope"
        or action.get("minimumPositiveSignsPerEstimatorPerSurface") != 18
        or action.get("minimumBcaLowerBoundBytesPerSecond") != 1_048_576 / 30
        or bootstrap.get("method") != "two-sided-95-percent-BCa"
        or bootstrap.get("resamples") != 10000
        or bootstrap.get("resampleOverrideAllowed") is not False
        or bootstrap.get("seed") != 0x3279B4E7
        or bootstrap.get("seedExpression") != "0x3279B4E7"
        or analysis.get("p95Claim") != "omitted-impossible-with-24-independent-blocks"
        or p95_receipt.get("independentBlockCount") != 24
        or p95_receipt.get("finiteUpperEndpointAvailable") is not False
    ):
        raise EvidenceError("preregistered action family or p95 method receipt drift")
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
            "availability": "NOT_CAPTURED_IN_REPORT_SCHEMA",
            "correlations": {},
            "reason": "No thermal, load, pressure, power, or free-memory telemetry fields are present in schema-v3 report bytes.",
        },
    }




def _sufficient_result(
    reports: Sequence[dict[str, Any]],
    prereg: dict[str, Any],
    hashes: dict[str, str],
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
    hashes: dict[str, str],
    prereg: dict[str, Any] | None = None,
    attempts: dict[str, int] | None = None,
    admitted: dict[str, int] | None = None,
    invalid: dict[str, int] | None = None,
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
    authenticated_driver_sha256: str,
    authenticated_preregistration_sha256: str,
    authenticated_template_sha256: str,
) -> dict[str, Any]:
    if not isinstance(expected_git_sha, str) or len(expected_git_sha) != 40 or any(character not in "0123456789abcdefABCDEF" for character in expected_git_sha):
        raise EvidenceError("expected git SHA must be 40 hexadecimal characters")
    for expected, label in (
        (authenticated_driver_sha256, "driver"),
        (authenticated_preregistration_sha256, "preregistration"),
        (authenticated_template_sha256, "template"),
    ):
        if not isinstance(expected, str) or len(expected) != 64 or any(character not in "0123456789abcdefABCDEF" for character in expected):
            raise EvidenceError(f"authenticated {label} SHA-256 is invalid")
    if _sha256_bytes(preregistration_bytes) != authenticated_preregistration_sha256.lower():
        raise EvidenceError("preregistration SHA-256 mismatch for supplied bytes")
    prereg_raw = _load_json_bytes(preregistration_bytes, "perf-corpus-preregistration.json", 1024 * 1024, 40)
    prereg = _validate_preregistration(prereg_raw)
    input_real = _safe_directory(Path(input_dir))
    output_real = _safe_directory(Path(output_dir), create=True)
    if input_real == output_real or input_real in output_real.parents or output_real in input_real.parents:
        raise EvidenceError("input and output directories must be disjoint")
    hashes = {
        "driverSha256": authenticated_driver_sha256.lower(),
        "preregistrationSha256": authenticated_preregistration_sha256.lower(),
        "templateSha256": authenticated_template_sha256.lower(),
        "expectedGitSha": expected_git_sha.lower(),
    }
    bounds = prereg["bounds"]
    schedule_items = prereg["captureControls"]["schedule"]
    admission_rows = prereg["captureControls"]["admissionRows"]
    expected_names = {item["expectedFilename"] for item in schedule_items}
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
        if entry.name not in expected_names or not entry.name.endswith(".json"):
            global_findings.append(
                _finding(
                    "UNEXPECTED_INPUT_ENTRY",
                    "STRUCTURE",
                    f"unexpected input directory entry: {entry.name}",
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
            info = entry_info[filename]
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                attempt_findings.append(
                    _finding(
                        "UNSAFE_INPUT_ENTRY",
                        "STRUCTURE",
                        f"input entry is not a regular non-symlink file: {filename}",
                        schedule,
                    )
                )
                invalid[profile] += 1
                continue
            if info.st_size > bounds["maximumBytesPerFile"]:
                attempt_findings.append(
                    _finding(
                        "BYTE_BOUND_EXCEEDED",
                        "RESOURCE_BOUND",
                        f"file exceeds byte bound: {filename}",
                        schedule,
                    )
                )
                invalid[profile] += 1
                continue
            try:
                report_value = _load_json_file(
                    input_real / filename,
                    bounds["maximumBytesPerFile"],
                    bounds["maximumJsonDepth"],
                )
                reports.append(_validate_report(report_value, schedule, prereg, expected_git_sha.lower()))
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
        result = _insufficient_result(all_findings, hashes, prereg, attempts, admitted, invalid)
    else:
        try:
            result = _sufficient_result(reports, prereg, hashes, attempts, invalid, attempt_findings)
        except EvidenceError as error:
            all_findings.append(_finding_from_error(error))
            result = _insufficient_result(all_findings, hashes, prereg, attempts, admitted, invalid)
    json_path, markdown_path = _write_canonical(output_real, result, bounds["maximumMarkdownBytes"])
    return {"result": result, "resultJsonPath": str(json_path), "resultMarkdownPath": str(markdown_path)}
