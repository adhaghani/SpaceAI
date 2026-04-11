from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any

import requests


@dataclass(slots=True)
class SentinelImageResult:
    image_available: bool
    image_bytes: bytes | None
    mime_type: str | None
    metadata: dict[str, Any]
    raw_image_bytes: int


class SimSatClient:
    def __init__(
        self,
        control_base_url: str = "http://localhost:8000",
        data_base_url: str = "http://localhost:9005",
        timeout_seconds: float = 15.0,
    ) -> None:
        self.control_base_url = control_base_url.rstrip("/")
        self.data_base_url = data_base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.session = requests.Session()

    def control_simulation(self, command: str, **kwargs: Any) -> dict[str, Any]:
        url = f"{self.control_base_url}/api/commands/"
        payload: dict[str, Any] = {"command": command}
        payload.update(kwargs)
        response = self.session.post(url, json=payload, timeout=self.timeout_seconds)
        response.raise_for_status()
        return self._safe_json(response)

    def get_current_position(self) -> dict[str, Any]:
        url = f"{self.data_base_url}/data/current/position"
        response = self.session.get(url, timeout=self.timeout_seconds)
        response.raise_for_status()
        return self._safe_json(response)

    def get_current_sentinel_image(
        self,
        spectral_bands: str = "swir22,nir,red",
        size_km: float = 10.0,
        return_type: str = "array",
        window_seconds: int = 864000,
    ) -> SentinelImageResult:
        url = f"{self.data_base_url}/data/current/image/sentinel"
        params = {
            "spectral_bands": spectral_bands,
            "size_km": size_km,
            "return_type": return_type,
            "window_seconds": window_seconds,
        }

        response = self.session.get(url, params=params, timeout=self.timeout_seconds)

        if response.status_code == 204:
            return SentinelImageResult(
                image_available=False,
                image_bytes=None,
                mime_type=None,
                metadata={"message": "No image available for current footprint."},
                raw_image_bytes=0,
            )

        response.raise_for_status()
        content_type = response.headers.get("content-type", "").lower()

        if "application/json" in content_type:
            body = self._safe_json(response)
            decoded = self._decode_image_from_json(body)
            image_bytes = decoded["image_bytes"]
            return SentinelImageResult(
                image_available=image_bytes is not None,
                image_bytes=image_bytes,
                mime_type=decoded["mime_type"],
                metadata=decoded["metadata"],
                raw_image_bytes=len(image_bytes) if image_bytes else 0,
            )

        image_bytes = response.content if response.content else None
        return SentinelImageResult(
            image_available=image_bytes is not None,
            image_bytes=image_bytes,
            mime_type=response.headers.get("content-type", "image/png"),
            metadata={
                "status_code": response.status_code,
                "headers": {
                    "content-type": response.headers.get("content-type"),
                    "content-length": response.headers.get("content-length"),
                },
            },
            raw_image_bytes=len(image_bytes) if image_bytes else 0,
        )

    @staticmethod
    def _safe_json(response: requests.Response) -> dict[str, Any]:
        data = response.json()
        if isinstance(data, dict):
            return data
        return {"data": data}

    @staticmethod
    def _decode_image_from_json(body: dict[str, Any]) -> dict[str, Any]:
        metadata = dict(body)
        image_bytes: bytes | None = None
        mime_type = body.get("mime_type")

        for key in ("image_base64", "image", "data"):
            value = body.get(key)
            if isinstance(value, str):
                try:
                    image_bytes = base64.b64decode(value, validate=False)
                    metadata.pop(key, None)
                    break
                except Exception:
                    continue

        for key in ("image_bytes",):
            value = body.get(key)
            if isinstance(value, list):
                try:
                    image_bytes = bytes(value)
                    metadata.pop(key, None)
                    break
                except Exception:
                    continue

        image_available = body.get("image_available")
        if image_available is False:
            image_bytes = None

        return {
            "image_bytes": image_bytes,
            "mime_type": mime_type,
            "metadata": metadata,
        }
