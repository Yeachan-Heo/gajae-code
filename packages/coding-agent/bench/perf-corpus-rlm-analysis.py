#!/usr/bin/env python3
"""Deterministic, stdlib-only analysis of sealed perf-corpus schema-v3 reports.

Canonical execution compiles these exact externally authenticated bytes through
the trusted notebook template. Corpus JSON is data only: this module never
imports from the corpus, evaluates artifact text, starts a process, or accesses
the network.
"""

from __future__ import annotations

import hashlib
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


def _median(values: Sequence[float]) -> float:
    if not values:
        raise EvidenceError("median requires at least one value")
    ordered = sorted(float(value) for value in values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def _summary(values: Sequence[float]) -> dict[str, float | int]:
    if not values:
        raise EvidenceError("descriptive summary requires at least one value")
    return {
        "count": len(values),
        "minimum": min(values),
        "median": _median(values),
        "maximum": max(values),
    }


def _optional_summary(values: Sequence[float]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "minimum": None, "median": None, "maximum": None}
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
    return _bca_interval(normalized, 20260727)

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
    if not math.isfinite(result) or (minimum_absolute_slope > 0 and abs(result) < minimum_absolute_slope):
        raise EvidenceError("Theil-Sen heap slope is zero, near-zero, or non-finite")
    return result


def _validate_sample(value: Any, label: str) -> dict[str, Any]:
    sample = _expect_dict(value, label)
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
        if not math.isfinite(float(endpoint_heap)) or abs(float(endpoint_heap)) < bounds["minimumAbsoluteActionSlopeBytesPerSecond"]:
            raise EvidenceError(f"{label}.heapSlopeBytesPerSecond is zero, near-zero, or non-finite")
    return {"baseline": baseline, "samples": samples, "theilSenHeapSlopeBytesPerSecond": theil_sen}


def _validate_report(value: Any, schedule: dict[str, Any], prereg: dict[str, Any], expected_git_sha: str) -> dict[str, Any]:
    report = _expect_dict(value, schedule["expectedFilename"])
    if report.get("schema") != REPORT_SCHEMA:
        raise EvidenceError(f"{schedule['expectedFilename']}: schema must be {REPORT_SCHEMA}")
    if report.get("gitSha") != expected_git_sha or not isinstance(report.get("gitSha"), str):
        raise EvidenceError(f"{schedule['expectedFilename']}: gitSha mismatch")
    if _expect_bool(report.get("gitDirty"), f"{schedule['expectedFilename']}.gitDirty"):
        raise EvidenceError(f"{schedule['expectedFilename']}: gitDirty must be false")
    _expect_string(report.get("generatedAt"), f"{schedule['expectedFilename']}.generatedAt")
    runner = _expect_dict(report.get("runner"), f"{schedule['expectedFilename']}.runner")
    profile = schedule["profile"]
    profile_config = prereg["cohort"]["profiles"][profile]
    if runner.get("profile") != profile:
        raise EvidenceError(f"{schedule['expectedFilename']}: profile mismatch")
    if runner.get("durationTargetMs") != profile_config["durationTargetMs"]:
        raise EvidenceError(f"{schedule['expectedFilename']}: duration target drift")
    if runner.get("iterationsTarget") != profile_config["iterationsTarget"]:
        raise EvidenceError(f"{schedule['expectedFilename']}: iterations target drift")
    if runner.get("memoryIsolation") != prereg["cohort"]["memoryIsolation"]:
        raise EvidenceError(f"{schedule['expectedFilename']}: memory isolation drift")
    for field in ("gcExposed", "memoryChildGcExposed"):
        _expect_bool(runner.get(field), f"{schedule['expectedFilename']}.runner.{field}")
    if runner.get("memoryChildGcExposed") is not True or runner.get("memoryChildExecArgv") != ["--smol", "--expose-gc"]:
        raise EvidenceError(f"{schedule['expectedFilename']}: isolated child controls drift")
    _expect_string(runner.get("command"), f"{schedule['expectedFilename']}.runner.command")
    argv = _expect_list(runner.get("argv"), f"{schedule['expectedFilename']}.runner.argv")
    if not argv or any(not isinstance(item, str) or not item for item in argv):
        raise EvidenceError(f"{schedule['expectedFilename']}: runner.argv is invalid")
    platform = _expect_string(runner.get("platform"), f"{schedule['expectedFilename']}.runner.platform")
    arch = _expect_string(runner.get("arch"), f"{schedule['expectedFilename']}.runner.arch")
    expected_order = schedule["surfaceOrder"]
    if runner.get("memorySurfaceOrder") != expected_order:
        raise EvidenceError(f"{schedule['expectedFilename']}: preregistered memory surface order mismatch")
    environment = _expect_dict(runner.get("environment"), f"{schedule['expectedFilename']}.runner.environment")
    if any(not isinstance(key, str) or not isinstance(item, str) for key, item in environment.items()):
        raise EvidenceError(f"{schedule['expectedFilename']}: runner.environment is invalid")
    expected_controls = {
        "GJC_MEMORY_PROFILE": profile,
        "GJC_MEMORY_ITERATIONS": str(profile_config["iterationsTarget"]),
        "GJC_MEMORY_SURFACE_ORDER": ",".join(expected_order),
    }
    if profile == "soak":
        expected_controls["GJC_MEMORY_DURATION_MS"] = str(profile_config["durationTargetMs"])
    elif "GJC_MEMORY_DURATION_MS" in environment:
        raise EvidenceError(f"{schedule['expectedFilename']}: short duration environment control is forbidden")
    for key, expected in expected_controls.items():
        if environment.get(key) != expected:
            raise EvidenceError(f"{schedule['expectedFilename']}: environment control {key} drift")
    _expect_list(report.get("hotspotClassifications"), f"{schedule['expectedFilename']}.hotspotClassifications")
    fixtures = _expect_list(report.get("fixtures"), f"{schedule['expectedFilename']}.fixtures")
    baselines: dict[str, dict[str, Any]] = {}
    observed_order: list[str] = []
    for index, fixture_value in enumerate(fixtures):
        fixture = _expect_dict(fixture_value, f"{schedule['expectedFilename']}.fixtures[{index}]")
        baseline_value = fixture.get("memoryBaseline")
        if baseline_value is None:
            continue
        validated = _validate_baseline(
            baseline_value,
            f"{schedule['expectedFilename']}.fixtures[{index}].memoryBaseline",
            profile,
            runner,
            profile_config,
            prereg["bounds"],
        )
        fixture_label = f"{schedule['expectedFilename']}.fixtures[{index}]"
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
        if any(rss_memory.get(field) != expected for field, expected in expected_rss_summary.items()):
            raise EvidenceError(f"{fixture_label}: rssMemory summary does not match periodic/extrema evidence")
        surface = validated["baseline"]["surface"]
        if surface in baselines:
            raise EvidenceError(f"{schedule['expectedFilename']}: duplicate memory surface {surface}")
        baselines[surface] = validated
        observed_order.append(surface)
    if set(baselines) != set(SURFACES) or len(baselines) != len(SURFACES):
        raise EvidenceError(f"{schedule['expectedFilename']}: exactly seven required memory surfaces are required")
    if observed_order != expected_order:
        raise EvidenceError(f"{schedule['expectedFilename']}: fixture order does not match preregistered order")
    return {
        "blockId": schedule["blockId"],
        "filename": schedule["expectedFilename"],
        "profile": profile,
        "platform": platform,
        "arch": arch,
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
        "maximumInputFiles": 29,
        "maximumBytesPerFile": 8_388_608,
        "maximumTotalInputBytes": 134_217_728,
        "maximumJsonDepth": 40,
        "maximumMarkdownBytes": 65_536,
        "minimumElapsedDeltaMs": 0.001,
        "minimumAbsoluteActionSlopeBytesPerSecond": 1e-9,
        "maximumTheilSenPairsPerBaseline": 253,
    }
    for field, expected in expected_bounds.items():
        raw = bounds.get(field)
        if isinstance(expected, int):
            _expect_integer(raw, f"preregistration.bounds.{field}", positive=True)
        else:
            _expect_number(raw, f"preregistration.bounds.{field}", nonnegative=True)
        if raw != expected:
            raise EvidenceError(f"preregistration bound drift: {field}")
    profiles = _expect_dict(_expect_dict(prereg.get("cohort"), "preregistration.cohort").get("profiles"), "preregistration.cohort.profiles")
    expected_profiles = {
        "short": {
            "requiredAdmittedBlocks": 5,
            "attemptCap": 5,
            "durationTargetMs": 0,
            "iterationsTarget": 200,
            "maximumPeriodicSamples": 22,
            "elapsedDurationToleranceMs": 30_000,
        },
        "soak": {
            "requiredAdmittedBlocks": 24,
            "attemptCap": 24,
            "durationTargetMs": 1000,
            "iterationsTarget": 100000,
            "maximumPeriodicSamples": 23,
            "elapsedDurationToleranceMs": 250,
        },
    }
    for profile, expected in expected_profiles.items():
        config = _expect_dict(profiles.get(profile), f"preregistration.cohort.profiles.{profile}")
        if any(config.get(field) != expected_value for field, expected_value in expected.items()):
            raise EvidenceError(f"preregistration {profile} count/cap/control drift")
    controls = _expect_dict(prereg.get("captureControls"), "preregistration.captureControls")
    if controls.get("requiredSurfaces") != list(SURFACES):
        raise EvidenceError("preregistration required surface drift")
    schedule = _expect_list(controls.get("schedule"), "preregistration.captureControls.schedule")
    if len(schedule) != 29:
        raise EvidenceError("preregistration schedule must contain 29 blocks")
    filenames: set[str] = set()
    block_ids: set[str] = set()
    for index, raw in enumerate(schedule):
        item = _expect_dict(raw, f"preregistration.captureControls.schedule[{index}]")
        block_id = _expect_string(item.get("blockId"), f"schedule[{index}].blockId")
        filename = _expect_string(item.get("expectedFilename"), f"schedule[{index}].expectedFilename")
        profile = item.get("profile")
        order = item.get("surfaceOrder")
        if (
            profile not in expected_profiles
            or filename != f"{block_id}.json"
            or not isinstance(order, list)
            or len(order) != 7
            or any(not isinstance(surface, str) for surface in order)
            or set(order) != set(SURFACES)
        ):
            raise EvidenceError(f"preregistration schedule[{index}] is invalid")
        if filename in filenames or block_id in block_ids:
            raise EvidenceError("preregistration schedule identifiers must be unique")
        filenames.add(filename)
        block_ids.add(block_id)
    for profile, expected in expected_profiles.items():
        if sum(item["profile"] == profile for item in schedule) != expected["requiredAdmittedBlocks"]:
            raise EvidenceError(f"preregistration schedule {profile} count mismatch")
    analysis = _expect_dict(prereg.get("analysis"), "preregistration.analysis")
    action = _expect_dict(analysis.get("actionFamily"), "preregistration.analysis.actionFamily")
    bootstrap = _expect_dict(action.get("bootstrap"), "preregistration.analysis.actionFamily.bootstrap")
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
        or bootstrap.get("seed") != 20260727
        or analysis.get("p95Claim") != "omitted"
    ):
        raise EvidenceError("preregistered action family drift")
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


def _sufficient_result(reports: Sequence[dict[str, Any]], prereg: dict[str, Any], hashes: dict[str, str]) -> dict[str, Any]:
    by_profile = {profile: [report for report in reports if report["profile"] == profile] for profile in ("short", "soak")}
    platforms = sorted({f"{report['platform']}/{report['arch']}" for report in reports})
    if len(platforms) != 1:
        raise EvidenceError("platform or architecture drift across admitted reports")
    descriptive = {
        profile: {surface: _surface_descriptives(by_profile[profile], surface) for surface in SURFACES}
        for profile in ("short", "soak")
    }
    action_config = prereg["analysis"]["actionFamily"]
    seed = action_config["bootstrap"]["seed"]
    if action_config["bootstrap"]["resamples"] != CANONICAL_RESAMPLES:
        raise EvidenceError("canonical BCa resample count drift")
    sign_minimum = action_config["minimumPositiveSignsPerEstimatorPerSurface"]
    lower_minimum = action_config["minimumBcaLowerBoundBytesPerSecond"]
    action_surfaces: dict[str, Any] = {}
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
            "primaryMedianBytesPerSecond": _median(endpoint),
            "primaryBca": interval,
            "endpointPositiveSigns": endpoint_positive,
            "theilSenMedianBytesPerSecond": _median(sensitivity),
            "theilSenPositiveSigns": sensitivity_positive,
            "minimumPositiveSignsRequired": sign_minimum,
            "minimumBcaLowerBoundBytesPerSecond": lower_minimum,
            "surfacePass": passed,
        }
    admission = {}
    for profile in ("short", "soak"):
        config = prereg["cohort"]["profiles"][profile]
        admission[profile] = {
            "attemptsObserved": len(by_profile[profile]),
            "attemptCap": config["attemptCap"],
            "requiredAdmittedBlocks": config["requiredAdmittedBlocks"],
            "admittedBlocks": len(by_profile[profile]),
            "invalidBlocks": 0,
            "notEvaluatedBlocks": 0,
            "excludedBlocks": 0,
            "allMembersAdmitted": True,
        }
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
        },
        "diagnostics": {
            "schemaDrift": [],
            "provenanceDrift": [],
            "profileControlDrift": [],
            "surfaceSetDrift": [],
            "surfaceOrderDrift": [],
            "platformDrift": [],
            "validatedBlockOrder": [report["blockId"] for report in reports],
        },
        "descriptiveByProfileAndSurface": descriptive,
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
            "p95": "OMITTED",
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
                "blockId": schedule["blockId"],
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
    elif "git" in lowered:
        code, category = "PROVENANCE_DRIFT", "PROVENANCE"
    elif "order" in lowered:
        code, category = "SURFACE_ORDER_DRIFT", "CONTROL"
    elif "seven required memory surfaces" in lowered:
        code, category = "SURFACE_SET_DRIFT", "CONTROL"
    elif "profile" in lowered or "duration" in lowered or "iterations" in lowered or "environment control" in lowered:
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
        not_evaluated = required - admitted[profile] - invalid[profile]
        if not_evaluated < 0:
            raise EvidenceError(f"{profile} admission accounting is inconsistent")
        admission[profile] = {
            "attemptsObserved": attempts[profile],
            "attemptCap": required,
            "requiredAdmittedBlocks": required,
            "admittedBlocks": admitted[profile],
            "invalidBlocks": invalid[profile],
            "notEvaluatedBlocks": not_evaluated,
            "excludedBlocks": 0,
            "allMembersAdmitted": admitted[profile] == required and invalid[profile] == 0 and not_evaluated == 0,
        }
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
        },
        "claimPolicy": {"p95": "OMITTED", "otherSurfaces": "DESCRIPTIVE_ONLY", "teardownAndExtrema": "DESCRIPTIVE_ONLY"},
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
    expected_names = {item["expectedFilename"] for item in schedule_items}
    attempts = {"short": 0, "soak": 0}
    admitted = {"short": 0, "soak": 0}
    invalid = {"short": 0, "soak": 0}
    invalid_names: set[str] = set()
    findings: list[dict[str, Any]] = []
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
        findings.append(_finding("INPUT_FILE_COUNT_BOUND_EXCEEDED", "RESOURCE_BOUND", "input directory exceeds file-count bound"))
    scanned_total_size = 0
    for entry in sorted(scanned_entries, key=lambda item: item.name):
        try:
            scanned_total_size += entry.stat(follow_symlinks=False).st_size
        except OSError as error:
            findings.append(
                _finding(
                    "INPUT_METADATA_UNAVAILABLE",
                    "STRUCTURE",
                    f"cannot stat input directory entry {entry.name}: {error.strerror}",
                )
            )
        if entry.name not in expected_names or not entry.name.endswith(".json"):
            findings.append(
                _finding(
                    "UNEXPECTED_INPUT_ENTRY",
                    "STRUCTURE",
                    f"unexpected input directory entry: {entry.name}",
                )
            )

    total_scheduled_size = 0
    safe_schedules: list[dict[str, Any]] = []
    for schedule in schedule_items:
        filename = schedule["expectedFilename"]
        path = input_real / filename
        try:
            info = path.lstat()
        except FileNotFoundError:
            findings.append(
                _finding(
                    "MISSING_SCHEDULED_BLOCK",
                    "STRUCTURE",
                    f"missing scheduled input: {filename}",
                    schedule,
                )
            )
            continue
        attempts[schedule["profile"]] += 1
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            findings.append(
                _finding(
                    "UNSAFE_INPUT_ENTRY",
                    "STRUCTURE",
                    f"input entry is not a regular non-symlink file: {filename}",
                    schedule,
                )
            )
            invalid[schedule["profile"]] += 1
            invalid_names.add(filename)
            continue
        total_scheduled_size += info.st_size
        if info.st_size > bounds["maximumBytesPerFile"]:
            findings.append(
                _finding(
                    "BYTE_BOUND_EXCEEDED",
                    "RESOURCE_BOUND",
                    f"file exceeds byte bound: {filename}",
                    schedule,
                )
            )
            invalid[schedule["profile"]] += 1
            invalid_names.add(filename)
            continue
        safe_schedules.append(schedule)

    total_bound_exceeded = max(total_scheduled_size, scanned_total_size) > bounds["maximumTotalInputBytes"]
    if total_bound_exceeded:
        findings.append(_finding("TOTAL_INPUT_BYTE_BOUND_EXCEEDED", "RESOURCE_BOUND", "input directory exceeds total-byte bound"))
    else:
        for schedule in safe_schedules:
            try:
                report_value = _load_json_file(
                    input_real / schedule["expectedFilename"],
                    bounds["maximumBytesPerFile"],
                    bounds["maximumJsonDepth"],
                )
                reports.append(_validate_report(report_value, schedule, prereg, expected_git_sha.lower()))
                admitted[schedule["profile"]] += 1
            except EvidenceError as error:
                findings.append(_finding_from_error(error, schedule))
                if schedule["expectedFilename"] not in invalid_names:
                    invalid[schedule["profile"]] += 1
                    invalid_names.add(schedule["expectedFilename"])

    if findings:
        result = _insufficient_result(findings, hashes, prereg, attempts, admitted, invalid)
    else:
        try:
            result = _sufficient_result(reports, prereg, hashes)
        except EvidenceError as error:
            findings.append(_finding_from_error(error))
            result = _insufficient_result(findings, hashes, prereg, attempts, admitted, invalid)
    json_path, markdown_path = _write_canonical(output_real, result, bounds["maximumMarkdownBytes"])
    return {"result": result, "resultJsonPath": str(json_path), "resultMarkdownPath": str(markdown_path)}
