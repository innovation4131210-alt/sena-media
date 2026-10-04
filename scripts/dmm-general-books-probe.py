#!/usr/bin/env python3
"""Bounded, read-only general-book ItemList test; sanitized output only.

Exact service/floor from successful FloorList run 37186876274.
No production imports, redirects, retries, file writes, or posting APIs.
"""
import http.client
import json
import os
import re
import sys
from urllib.parse import urlencode, urlsplit, parse_qsl, unquote

HOST = "api.dmm.com"
ENDPOINT = "/affiliate/v3/ItemList"
# Reuse the existing repository configuration; never emit tracking URLs.
AFFILIATE_ID = "eromimimimi-990"
SITE, SERVICE, FLOOR = "DMM.com", "ebook", "otherbooks"
QUERIES = ("ChatGPT", "生成AI")
MAX_ITEMS, MAX_BYTES = 5, 1024 * 1024
BLOCKED = re.compile(r"fanza|adult|アダルト|官能|エロ|セックス|性行為|ヌード|グラビア|写真集|18禁|r[- ]?18", re.I)
TOPIC = re.compile(r"chat\s*gpt|生成\s*ai", re.I)
FIELDS = ["service_code", "floor_code", "content_id", "title", "URL", "prices.price",
          "prices.list_price", "date", "stock", "iteminfo.author[].name",
          "iteminfo.maker[].name", "iteminfo.genre[].name"]

class InvalidData(Exception):
    pass

def safe_text(value, api_id, limit=300):
    if not isinstance(value, str) or not 1 <= len(value) <= limit:
        raise InvalidData()
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise InvalidData()
    if api_id in unquote(value) or AFFILIATE_ID in unquote(value):
        raise InvalidData()
    if any(x in value.lower() for x in ("http:", "https:", "api_id", "affiliate_id")):
        raise InvalidData()
    return value

def nontracking_url(value, api_id):
    if not isinstance(value, str) or len(value) > 1000 or any(ord(c)<33 for c in value):
        raise InvalidData()
    decoded = unquote(value)
    if api_id in decoded or AFFILIATE_ID in decoded or BLOCKED.search(decoded) or any(ord(c) < 33 for c in decoded):
        raise InvalidData()
    u = urlsplit(value)
    allowed = (u.hostname == "book.dmm.com" and u.path.startswith(("/detail/", "/product/"))) or (u.hostname == "www.dmm.com" and u.path.startswith("/dc/book/-/detail/"))
    if u.scheme != "https" or not allowed or u.username or u.password or u.port or u.fragment:
        raise InvalidData()
    if not re.fullmatch(r"[A-Za-z0-9_/=.-]+", u.path):
        raise InvalidData()
    if any(k != "cid" or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", v) for k, v in parse_qsl(u.query, keep_blank_values=True)):
        raise InvalidData()
    return value

def number(value):
    if isinstance(value, bool) or not re.fullmatch(r"[0-9]{1,9}", str(value)):
        raise InvalidData()
    return int(value)

def names(info, key, api_id):
    values = info.get(key, [])
    if not isinstance(values, list) or len(values) > 30:
        raise InvalidData()
    return [safe_text(x.get("name"), api_id, 120) for x in values if isinstance(x, dict)]

def item_record(item, api_id):
    if not isinstance(item, dict) or item.get("service_code") != SERVICE or item.get("floor_code") != FLOOR:
        raise InvalidData()
    title = safe_text(item.get("title"), api_id)
    info = item.get("iteminfo", {})
    if not isinstance(info, dict):
        raise InvalidData()
    authors, publishers, genres = (names(info, k, api_id) for k in ("author", "maker", "genre"))
    if not TOPIC.search(title) or BLOCKED.search(" ".join([title] + authors + publishers + genres)):
        raise InvalidData()
    record = {"title": title, "URL": nontracking_url(item.get("URL"), api_id),
              "service_code": SERVICE, "floor_code": FLOOR}
    cid = item.get("content_id")
    if isinstance(cid, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,100}", cid) and api_id not in cid and AFFILIATE_ID not in cid and not BLOCKED.search(cid):
        record["content_id"] = cid
    prices = item.get("prices", {})
    if not isinstance(prices, dict):
        raise InvalidData()
    for key in ("price", "list_price"):
        if key in prices:
            val = str(prices[key])
            if re.fullmatch(r"[0-9,]+(?:[〜～~-][0-9,]*)?", val):
                record[key] = val
    record["currency"] = "JPY"
    date = item.get("date")
    if isinstance(date, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?", date):
        record["date"] = date
    stock = item.get("stock")
    record["stock_field_present"] = "stock" in item
    if isinstance(stock, str) and stock in ("stock", "reserve", "reserve_empty", "empty", "販売中", "配信中", "在庫あり"):
        record["stock"] = stock
    record["availability_evidence"] = "API_LISTED; storefront purchase availability not independently verified"
    record.update(authors=authors, publishers=publishers, genres=genres)
    record["field_presence"] = {k: k in item for k in ("service_code", "floor_code", "title", "URL", "prices", "date", "stock", "iteminfo")}
    return record

def parse_payload(payload, api_id):
    if not isinstance(payload, dict) or not isinstance(payload.get("result"), dict):
        return {"status": "INVALID_RESULT_SCHEMA"}
    result = payload["result"]
    api_status = result.get("status")
    if api_status is not None and str(api_status) != "200":
        if re.fullmatch(r"[1-5][0-9]{2}", str(api_status)):
            return {"status": "API_REPORTED_ERROR", "api_status": int(api_status)}
        return {"status": "INVALID_API_STATUS"}
    if result.get("errors") or result.get("error"):
        return {"status": "API_ERROR_FIELD_PRESENT"}
    items = result.get("items")
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        return {"status": "INVALID_ITEMS_SCHEMA"}
    safe, filtered = [], 0
    for item in items:
        try:
            safe.append(item_record(item, api_id))
        except (ValueError, TypeError, InvalidData):
            filtered += 1
    output = {"status": "OK", "api_status": 200 if api_status is not None else "omitted",
              "returned_count": len(items), "safe_item_count": len(safe),
              "filtered_count": filtered, "items": safe}
    for key in ("result_count", "total_count"):
        if key in result:
            try:
                output[key] = number(result[key])
            except InvalidData:
                output[key + "_valid"] = False
    return output

def request_once(api_id, keyword, connection_factory):
    connection = None
    try:
        params = {"api_id": api_id, "affiliate_id": AFFILIATE_ID, "site": SITE,
                  "service": SERVICE, "floor": FLOOR, "hits": MAX_ITEMS,
                  "offset": 1, "sort": "rank", "keyword": keyword, "output": "json"}
        connection = connection_factory(HOST, timeout=20)
        connection.request("GET", ENDPOINT + "?" + urlencode(params),
                           headers={"Accept": "application/json", "User-Agent": "sena-media-general-books-probe/1"})
        response = connection.getresponse()
        if response.status != 200:
            return {"status": "HTTP_ERROR", "http_status": response.status}
        if response.getheader("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            return {"status": "UNEXPECTED_CONTENT_TYPE", "http_status": 200}
        raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            return {"status": "RESPONSE_TOO_LARGE", "http_status": 200}
        outcome = parse_payload(json.loads(raw), api_id)
        return {"http_status": 200, **outcome}
    except (OSError, http.client.HTTPException):
        return {"status": "NETWORK_ERROR"}
    except (ValueError, InvalidData):
        return {"status": "INVALID_JSON_OR_DATA"}
    except Exception:
        return {"status": "PROBE_ERROR"}
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass

def run(environ, connection_factory=http.client.HTTPSConnection):
    if environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch" or environ.get("GITHUB_RUN_ATTEMPT") != "1":
        return {"status": "MANUAL_FIRST_ATTEMPT_REQUIRED", "request_count": 0}
    api_id = environ.get("DMM_API_ID", "").strip()
    if not api_id:
        return {"status": "MISSING_API_CONFIGURATION", "request_count": 0}
    output = {"site": SITE, "service": SERVICE, "floor": FLOOR, "fields_tested": FIELDS,
              "max_items_per_request": MAX_ITEMS, "requests": []}
    for query in QUERIES:
        result = request_once(api_id, query, connection_factory)
        output["requests"].append({"keyword": query, **result})
        # Never retry any error, including access denial. Fallback is only for empty safe results.
        if result["status"] != "OK" or result.get("safe_item_count", 0):
            break
    output["request_count"] = len(output["requests"])
    output["status"] = output["requests"][-1]["status"]
    return output

if __name__ == "__main__":
    outcome = run(os.environ)
    print(json.dumps(outcome, ensure_ascii=False, indent=2))
    sys.exit(0 if outcome["status"] == "OK" else 1)
