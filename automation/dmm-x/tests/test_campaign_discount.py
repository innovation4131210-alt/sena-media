#!/usr/bin/env python3
"""Regression tests for DMM X verified-campaign copy; no external API calls."""
import importlib.util
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "buffer_queue.py"
spec = importlib.util.spec_from_file_location("dmm_buffer_queue", MODULE_PATH)
queue = importlib.util.module_from_spec(spec)
spec.loader.exec_module(queue)

JST = timezone(timedelta(hours=9))
AFFILIATE_URL = (
    "https://al.fanza.co.jp/?lurl=https%3A%2F%2Fvideo.dmm.co.jp%2Fav"
    "%2Fcontent%2F%3Fid%3Ddemo001&af_id=eromimimimi-990&ch=api"
)


def item_with_campaign(begin, end):
    return {
        "prices": {"price": "500", "list_price": "1000"},
        "review": {"average": "4.8", "count": "25"},
        "campaign": [{
            "title": "test campaign",
            "date_begin": begin.strftime("%Y-%m-%d %H:%M:%S") if begin else "",
            "date_end": end.strftime("%Y-%m-%d %H:%M:%S") if end else "",
        }],
    }


class CampaignCopyTests(unittest.TestCase):
    def test_campaign_must_cover_actual_scheduled_due_at(self):
        due = datetime.now(JST) + timedelta(hours=3)
        self.assertTrue(queue.active_campaign_info(
            item_with_campaign(due - timedelta(days=1), due + timedelta(days=1)),
            required_at=due,
        )["active"])
        self.assertFalse(queue.active_campaign_info(
            item_with_campaign(due - timedelta(days=1), due - timedelta(seconds=1)),
            required_at=due,
        )["active"])
        self.assertFalse(queue.active_campaign_info(
            item_with_campaign(due + timedelta(seconds=1), due + timedelta(days=1)),
            required_at=due,
        )["active"])
        self.assertFalse(queue.active_campaign_info(
            item_with_campaign(due - timedelta(days=1), None),
            required_at=due,
        )["active"])

    def test_inactive_campaign_never_emits_discount_copy(self):
        item = item_with_campaign(None, None)
        facts = queue.product_facts(item, "架空の女優", campaign_active=False)
        self.assertIn("出演：架空の女優", facts)
        self.assertNotIn("OFF", facts)
        meta = {
            "actress_name": "架空の女優",
            "price": 500,
            "discount_pct": 50,
            "campaign_active": False,
            "review_average": 4.8,
            "review_count": 25,
        }
        self.assertNotIn("OFF", queue.compact_value_line(meta))
        result = queue.build_decision_text(
            1, "作品名", "review", AFFILIATE_URL, facts=facts, meta=meta
        )
        self.assertNotIn("OFF", result)
        self.assertIn("架空の女優", result)
        self.assertIn(AFFILIATE_URL, result)
        self.assertLessEqual(queue.x_weighted_length(result), 280)

    def test_expired_promotion_price_is_not_promised_at_future_due_at(self):
        item = item_with_campaign(None, None)
        facts = queue.product_facts(item, "架空の女優", campaign_active=False)
        self.assertIn("出演：架空の女優", facts)
        self.assertIn("★4.8（25件）", facts)
        self.assertNotIn("500円", facts)
        meta = {
            "actress_name": "架空の女優",
            "price": 500,
            "discount_pct": 50,
            "campaign_active": False,
            "review_average": 4.8,
            "review_count": 25,
        }
        self.assertNotIn("500円", queue.compact_value_line(meta))
        self.assertIn("★4.8（25件）", queue.compact_value_line(meta))
        self.assertIn("500円", queue.product_facts(
            item_with_campaign(None, None), "架空の女優",
            campaign_active=True
        ))

    def test_repairs_only_future_scheduled_price_claim(self):
        due = (datetime.now(timezone.utc) + timedelta(hours=6)).isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z")
        old = "【PR】候補メモ。\\n出演：架空の女優 / 10円\\n" + AFFILIATE_URL
        expected = "【PR】候補メモ。\\n出演：架空の女優 / ★4.4（128件）\\n" + AFFILIATE_URL
        row = {
            "buffer_post_id": "scheduled-1", "kind": "affiliate",
            "campaign_active": False, "discount_pct": 99, "price": 10,
            "actress_name": "架空の女優",
            "review_average": 4.43, "review_count": 128,
            "content_id": "demo001", "format": "discovery",
        }
        post = {
            "id": "scheduled-1", "text": old, "dueAt": due,
            "status": "scheduled",
        }
        with patch.object(queue, "edit_post_text", return_value={
            "id": "scheduled-1", "text": expected,
            "dueAt": due, "status": "scheduled",
        }) as edit:
            repaired = queue.repair_scheduled_unverified_price_claims(
                {"post_history": [row]}, [post]
            )
            self.assertEqual(len(repaired), 1)
            edit.assert_called_once_with("scheduled-1", expected)
            self.assertIn("price_claim_repaired_at", row)
        with patch.object(queue, "edit_post_text") as edit:
            queue.repair_scheduled_unverified_price_claims(
                {"post_history": [row]}, [{
                    **post, "text": expected
                }]
            )
            edit.assert_not_called()

    def test_active_campaign_can_emit_discount_copy(self):
        item = item_with_campaign(None, None)
        facts = queue.product_facts(item, "架空の女優", campaign_active=True)
        self.assertIn("約50%OFF", facts)
        meta = {
            "actress_name": "架空の女優",
            "price": 500,
            "discount_pct": 50,
            "campaign_active": True,
            "campaign_title": "test campaign",
            "campaign_end": "2099-12-31 23:59:59",
        }
        self.assertIn("約50%OFF", queue.compact_value_line(meta))

    def test_compact_copy_keeps_proof_and_link_without_false_discount(self):
        meta = {
            "actress_name": "架空の女優",
            "review_average": 4.8,
            "review_count": 25,
            "price": 500,
            "discount_pct": 50,
            "campaign_active": False,
        }
        result = queue.build_compact_affiliate_text(
            "長い作品名" * 80, AFFILIATE_URL, meta, format_name="decision"
        )
        self.assertNotIn("OFF", result)
        self.assertIn("架空の女優", result)
        self.assertIn("★4.8（25件）", result)
        self.assertIn(AFFILIATE_URL, result)
        self.assertLessEqual(queue.x_weighted_length(result), 280)
        self.assertFalse(queue.is_generic_fallback_text(result))


if __name__ == "__main__":
    unittest.main()
