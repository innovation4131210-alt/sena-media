#!/usr/bin/env python3
"""One read-only FloorList request; print only general DMM.com metadata.

API reference: https://affiliate.dmm.com/api/v3/floorlist.html
No imports from production automation; no item, posting, or file-write calls.
"""

import http.client
import json
import os
import re
import sys
from urllib.parse import urlencode

HOST = "api.dmm.com"
ENDPOINT = "/affiliate/v3/FloorList"
# Reuse the affiliate identifier already configured in automation/dmm-x/buffer_queue.py.
AFFILIATE_ID = "eromimimimi-990"
MAX_BYTES = 1024 * 1024


class InvalidMetadata(Exception):
    pass


def field(value, api_id, *, code=False):
    """Fail closed on unexpected text; never emit URLs, credentials or controls."""
    if not isinstance(value, str) or not 1 <= len(value) <= 160:
        raise InvalidMetadata()
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise InvalidMetadata()
    if api_id in value or AFFILIATE_ID in value:
        raise InvalidMetadata()
    if any(s in value.lower() for s in ("http:", "https:", "api_id", "affiliate_id", "fanza")):
        raise InvalidMetadata()
    if code and not re.fullmatch(r"[A-Za-z0-9_.-]+", value):
        raise InvalidMetadata()
    return value


def general_metadata(payload, api_id):
    """Select the exact general-site code before accessing service/floor fields."""
    if not isinstance(payload, dict) or not isinstance(payload.get("result"), dict):
        raise InvalidMetadata()
    result = payload["result"]
    if str(result.get("status")) != "200":
        return {"status": "API_ERROR"}
    sites = result.get("site")
    if not isinstance(sites, list):
        raise InvalidMetadata()
    general = [s for s in sites if isinstance(s, dict) and s.get("code") == "DMM.com"]
    if len(general) != 1:
        return {"status": "GENERAL_SITE_UNAVAILABLE"}
    services = general[0].get("service")
    if not isinstance(services, list) or not services:
        raise InvalidMetadata()
    output = []
    for service in services:
        if not isinstance(service, dict) or not isinstance(service.get("floor"), list):
            raise InvalidMetadata()
        floors = []
        for floor in service["floor"]:
            if not isinstance(floor, dict):
                raise InvalidMetadata()
            floors.append({"name": field(floor.get("name"), api_id),
                           "code": field(floor.get("code"), api_id, code=True)})
        output.append({"name": field(service.get("name"), api_id),
                       "code": field(service.get("code"), api_id, code=True),
                       "floors": floors})
    return {"status": "OK", "site": "DMM.com", "services": output}


def run(environ, connection_factory=http.client.HTTPSConnection):
    # A GitHub rerun is not permission for a second external probe.
    if environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch" or environ.get("GITHUB_RUN_ATTEMPT") != "1":
        return {"status": "MANUAL_FIRST_ATTEMPT_REQUIRED"}
    api_id = environ.get("DMM_API_ID", "").strip()
    if not api_id:
        return {"status": "MISSING_API_CONFIGURATION"}
    connection = None
    try:
        query = urlencode({"api_id": api_id, "affiliate_id": AFFILIATE_ID, "output": "json"})
        connection = connection_factory(HOST, timeout=20)
        # Exactly one request. http.client neither follows redirects nor retries.
        connection.request("GET", ENDPOINT + "?" + query,
                           headers={"Accept": "application/json",
                                    "User-Agent": "sena-media-general-metadata-probe/1"})
        response = connection.getresponse()
        if response.status != 200:
            return {"status": "HTTP_ERROR", "http_status": response.status}
        if response.getheader("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            return {"status": "UNEXPECTED_CONTENT_TYPE"}
        raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            return {"status": "RESPONSE_TOO_LARGE"}
        return general_metadata(json.loads(raw), api_id)
    except (OSError, http.client.HTTPException):
        return {"status": "NETWORK_ERROR"}
    except (ValueError, InvalidMetadata):
        return {"status": "INVALID_METADATA"}
    except Exception:
        # Do not print exception text, request URLs, or raw API response content.
        return {"status": "PROBE_ERROR"}
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass


if __name__ == "__main__":
    outcome = run(os.environ)
    print(json.dumps(outcome, ensure_ascii=False, indent=2))
    sys.exit(0 if outcome["status"] == "OK" else 1)
