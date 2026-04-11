from __future__ import annotations

import asyncio
import base64
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.inference import analyze_for_fire
from backend.simsat_client import SimSatClient

SIMSAT_CONTROL_URL = os.getenv("SIMSAT_CONTROL_URL", "http://localhost:8000")
SIMSAT_DATA_URL = os.getenv("SIMSAT_DATA_URL", "http://localhost:9005")
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")
POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "2.0"))

DEFAULT_SPECTRAL_BANDS = os.getenv("SPECTRAL_BANDS", "swir22,nir,red")
DEFAULT_SIZE_KM = float(os.getenv("SIZE_KM", "10.0"))
DEFAULT_RETURN_TYPE = os.getenv("RETURN_TYPE", "array")
DEFAULT_WINDOW_SECONDS = int(os.getenv("WINDOW_SECONDS", "864000"))

latest_state: dict[str, Any] = {
    "updated_at": None,
    "telemetry": {
        "lat": None,
        "lon": None,
        "alt": None,
        "time": None,
    },
    "image_available": False,
    "image_base64": None,
    "image_mime_type": None,
    "image_metadata": {},
    "vlm_result": {
        "fire_detected": False,
        "confidence": 0.0,
        "lat": 0.0,
        "lon": 0.0,
        "severity": "low",
    },
    "vlm_payload_json": None,
    "bandwidth": {
        "raw_image_bytes": 0,
        "vlm_payload_bytes": 0,
        "savings_percent": 0.0,
    },
    "errors": [],
}

state_lock = asyncio.Lock()
stream_task: asyncio.Task[None] | None = None
client = SimSatClient(control_base_url=SIMSAT_CONTROL_URL, data_base_url=SIMSAT_DATA_URL)


class ControlRequest(BaseModel):
    command: str = Field(..., examples=["start", "pause", "resume", "stop"])
    kwargs: dict[str, Any] = Field(default_factory=dict)


async def continuous_data_streamer() -> None:
    while True:
        cycle_timestamp = datetime.now(timezone.utc).isoformat()
        cycle_errors: list[str] = []

        try:
            position = await asyncio.to_thread(client.get_current_position)
        except Exception as exc:
            position = {}
            cycle_errors.append(f"position_fetch_failed: {exc}")

        try:
            image_result = await asyncio.to_thread(
                client.get_current_sentinel_image,
                DEFAULT_SPECTRAL_BANDS,
                DEFAULT_SIZE_KM,
                DEFAULT_RETURN_TYPE,
                DEFAULT_WINDOW_SECONDS,
            )
        except Exception as exc:
            image_result = None
            cycle_errors.append(f"image_fetch_failed: {exc}")

        telemetry = {
            "lat": _to_float(position.get("lat") or position.get("latitude")),
            "lon": _to_float(position.get("lon") or position.get("longitude")),
            "alt": _to_float(position.get("alt") or position.get("altitude")),
            "time": position.get("time") or position.get("timestamp") or cycle_timestamp,
        }

        image_available = bool(image_result and image_result.image_available and image_result.image_bytes)
        image_bytes = image_result.image_bytes if image_result else None
        image_base64 = base64.b64encode(image_bytes).decode("utf-8") if image_bytes else None

        image_metadata = dict(image_result.metadata) if image_result else {}
        if telemetry["lat"] is not None:
            image_metadata.setdefault("lat", telemetry["lat"])
        if telemetry["lon"] is not None:
            image_metadata.setdefault("lon", telemetry["lon"])

        try:
            inference = analyze_for_fire(image_bytes, image_metadata)
        except Exception as exc:
            cycle_errors.append(f"inference_failed: {exc}")
            inference = {
                "result": {
                    "fire_detected": False,
                    "confidence": 0.0,
                    "lat": float(telemetry["lat"] or 0.0),
                    "lon": float(telemetry["lon"] or 0.0),
                    "severity": "low",
                },
                "payload_json": '{"fire_detected":false,"confidence":0.0,"lat":0.0,"lon":0.0,"severity":"low"}',
                "payload_bytes": 78,
                "prompt_used": None,
                "model": "fallback",
            }

        raw_bytes = image_result.raw_image_bytes if image_result else 0
        payload_bytes = int(inference.get("payload_bytes", 0))
        savings = 0.0
        if raw_bytes > 0:
            savings = ((raw_bytes - payload_bytes) / raw_bytes) * 100.0
            savings = max(0.0, min(100.0, savings))

        async with state_lock:
            latest_state["updated_at"] = cycle_timestamp
            latest_state["telemetry"] = telemetry
            latest_state["image_available"] = image_available
            latest_state["image_base64"] = image_base64
            latest_state["image_mime_type"] = image_result.mime_type if image_result else None
            latest_state["image_metadata"] = image_metadata
            latest_state["vlm_result"] = inference["result"]
            latest_state["vlm_payload_json"] = inference["payload_json"]
            latest_state["bandwidth"] = {
                "raw_image_bytes": raw_bytes,
                "vlm_payload_bytes": payload_bytes,
                "savings_percent": round(savings, 2),
            }
            latest_state["errors"] = cycle_errors

        await asyncio.sleep(POLL_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global stream_task
    stream_task = asyncio.create_task(continuous_data_streamer())
    try:
        yield
    finally:
        if stream_task:
            stream_task.cancel()
            try:
                await stream_task
            except asyncio.CancelledError:
                pass


app = FastAPI(title="SimSat Fire Monitoring API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN, "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/state")
async def get_state() -> dict[str, Any]:
    async with state_lock:
        return dict(latest_state)


@app.post("/api/control")
async def control_simulation(request: ControlRequest) -> dict[str, Any]:
    try:
        result = await asyncio.to_thread(client.control_simulation, request.command, **request.kwargs)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"SimSat control relay failed: {exc}") from exc

    return {
        "ok": True,
        "command": request.command,
        "result": result,
    }


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
