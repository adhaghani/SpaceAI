from __future__ import annotations

import json
import os
import re
from io import BytesIO
from typing import Any

from PIL import Image
import requests


VLM_PROMPT = (
    "You are an orbital wildfire analyst operating on constrained satellite bandwidth. "
    "Inspect this Sentinel-2 false-color composite (SWIR/NIR/Red) and identify likely thermal "
    "anomalies, active flame fronts, or high-temperature smoke-obscured hotspots. "
    "Return STRICT JSON only in this exact schema: "
    '{"fire_detected": true|false, "confidence": 0.0-1.0, "lat": number, "lon": number, "severity": "low|medium|high"}'
)

LM_STUDIO_ENABLED = os.getenv("LM_STUDIO_ENABLED", "true").lower() == "true"
LM_STUDIO_BASE_URL = os.getenv("LM_STUDIO_BASE_URL", "http://127.0.0.1:1234/v1").rstrip("/")
LM_STUDIO_MODEL = os.getenv("LM_STUDIO_MODEL", "lfm2.5-vl-450m")
LM_STUDIO_TIMEOUT_SECONDS = float(os.getenv("LM_STUDIO_TIMEOUT_SECONDS", "40"))


def analyze_for_fire(image_data: bytes | None, metadata: dict[str, Any]) -> dict[str, Any]:
    if not image_data:
        result = {
            "fire_detected": False,
            "confidence": 0.01,
            "lat": float(metadata.get("lat", 0.0)),
            "lon": float(metadata.get("lon", 0.0)),
            "severity": "low",
        }
        model_name = "no-image-fallback"
    else:
        if LM_STUDIO_ENABLED:
            try:
                result = _analyze_with_lm_studio(image_data, metadata)
                model_name = f"lm-studio:{LM_STUDIO_MODEL}"
            except Exception:
                result = _heuristic_fire_stub(image_data, metadata)
                model_name = "heuristic-fallback"
        else:
            result = _heuristic_fire_stub(image_data, metadata)
            model_name = "lfm2-vl-placeholder"

    payload_json = json.dumps(result, separators=(",", ":"))
    payload_bytes = len(payload_json.encode("utf-8"))

    return {
        "result": result,
        "payload_json": payload_json,
        "payload_bytes": payload_bytes,
        "prompt_used": VLM_PROMPT,
        "model": model_name,
    }


def _analyze_with_lm_studio(image_data: bytes, metadata: dict[str, Any]) -> dict[str, Any]:
    image_base64 = _bytes_to_data_url(image_data)
    chat_url = f"{LM_STUDIO_BASE_URL}/chat/completions"

    response = requests.post(
        chat_url,
        timeout=LM_STUDIO_TIMEOUT_SECONDS,
        headers={"Content-Type": "application/json"},
        json={
            "model": LM_STUDIO_MODEL,
            "temperature": 0.0,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a strict JSON-only orbital wildfire detector.",
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": VLM_PROMPT},
                        {"type": "image_url", "image_url": {"url": image_base64}},
                    ],
                },
            ],
        },
    )
    response.raise_for_status()
    data = response.json()

    raw_content = (
        data.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "")
    )
    parsed = _extract_json_object(raw_content)

    if metadata.get("lat") is not None and parsed.get("lat") in (None, 0, 0.0):
        parsed["lat"] = float(metadata["lat"])
    if metadata.get("lon") is not None and parsed.get("lon") in (None, 0, 0.0):
        parsed["lon"] = float(metadata["lon"])

    return _normalize_result(parsed, metadata)


def _bytes_to_data_url(image_data: bytes) -> str:
    import base64

    encoded = base64.b64encode(image_data).decode("utf-8")
    return f"data:image/png;base64,{encoded}"


def _extract_json_object(text: str) -> dict[str, Any]:
    if not isinstance(text, str) or not text.strip():
        raise ValueError("LM Studio returned empty content")

    try:
        direct = json.loads(text)
        if isinstance(direct, dict):
            return direct
    except json.JSONDecodeError:
        pass

    # Handle fenced blocks or surrounding prose.
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise ValueError("LM Studio content did not contain JSON object")

    parsed = json.loads(match.group(0))
    if not isinstance(parsed, dict):
        raise ValueError("LM Studio JSON content is not an object")
    return parsed


def _normalize_result(raw: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
    severity = str(raw.get("severity", "low")).lower()
    if severity not in {"low", "medium", "high"}:
        severity = "low"

    confidence = raw.get("confidence", 0.01)
    try:
        confidence_value = float(confidence)
    except (TypeError, ValueError):
        confidence_value = 0.01
    confidence_value = max(0.0, min(1.0, confidence_value))

    lat = _to_float(raw.get("lat"), default=_to_float(metadata.get("lat"), 0.0))
    lon = _to_float(raw.get("lon"), default=_to_float(metadata.get("lon"), 0.0))

    fire_raw = raw.get("fire_detected", False)
    if isinstance(fire_raw, bool):
        fire_detected = fire_raw
    elif isinstance(fire_raw, (int, float)):
        fire_detected = fire_raw != 0
    elif isinstance(fire_raw, str):
        fire_detected = fire_raw.strip().lower() in {"true", "1", "yes"}
    else:
        fire_detected = False

    return {
        "fire_detected": fire_detected,
        "confidence": round(confidence_value, 3),
        "lat": lat,
        "lon": lon,
        "severity": severity,
    }


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _heuristic_fire_stub(image_data: bytes, metadata: dict[str, Any]) -> dict[str, Any]:
    image = Image.open(BytesIO(image_data)).convert("RGB")
    pixels = list(image.getdata())
    total_pixels = len(pixels)

    if total_pixels == 0:
        confidence = 0.02
    else:
        hot_pixels = sum(1 for r, g, b in pixels if r > 210 and g < 160 and b < 120)
        ratio = hot_pixels / total_pixels
        confidence = min(0.99, max(0.05, ratio * 40))

    fire_detected = confidence > 0.55

    if confidence > 0.8:
        severity = "high"
    elif confidence > 0.55:
        severity = "medium"
    else:
        severity = "low"

    return {
        "fire_detected": fire_detected,
        "confidence": round(confidence, 3),
        "lat": float(metadata.get("lat", 0.0)),
        "lon": float(metadata.get("lon", 0.0)),
        "severity": severity,
    }
