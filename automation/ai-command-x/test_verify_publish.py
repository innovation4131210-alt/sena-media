#!/usr/bin/env python3
"""Offline regression tests: python3 -m unittest discover -s automation/ai-command-x -p 'test_*.py' -v."""

import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "verify_publish", Path(__file__).with_name("verify_publish.py")
)
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)


class TargetSlotTests(unittest.TestCase):
    def setUp(self):
        self.grace = patch.object(verify, "GRACE_MINUTES", 25)
        self.grace.start()
        self.addCleanup(self.grace.stop)

    def assert_slot(self, now, expected):
        self.assertEqual(
            verify.target_slot(datetime.fromisoformat(now)),
            datetime.fromisoformat(expected),
        )

    def test_delayed_evening_run_after_midnight(self):
        # The 2026-10-03 evening job actually started at 00:01 JST on Oct 4.
        self.assert_slot("2026-10-04T00:01:22+09:00", "2026-10-03T20:30+09:00")

    def test_before_first_daily_slot_uses_previous_evening(self):
        self.assert_slot("2026-10-04T08:09:59+09:00", "2026-10-03T20:30+09:00")

    def test_morning_slot_is_not_eligible_before_grace(self):
        self.assert_slot("2026-10-04T08:34:59+09:00", "2026-10-03T20:30+09:00")

    def test_grace_boundary_is_inclusive(self):
        self.assert_slot("2026-10-04T08:35:00+09:00", "2026-10-04T08:10+09:00")

    def test_each_normal_verification_time(self):
        for now, slot in (("08:45", "08:10"), ("12:55", "12:20"), ("21:05", "20:30")):
            with self.subTest(now=now):
                self.assert_slot(f"2026-10-04T{now}+09:00", f"2026-10-04T{slot}+09:00")

    def test_noon_slot_is_not_eligible_before_grace(self):
        self.assert_slot("2026-10-04T12:44:59+09:00", "2026-10-04T08:10+09:00")

    def test_evening_slot_is_not_eligible_before_grace(self):
        self.assert_slot("2026-10-04T20:54:59+09:00", "2026-10-04T12:20+09:00")

    def test_utc_input_uses_jst_calendar_date(self):
        self.assert_slot("2026-10-03T23:45:00+00:00", "2026-10-04T08:10+09:00")

    def test_western_timezone_input_uses_jst_calendar_date(self):
        self.assert_slot("2026-10-03T16:45:00-07:00", "2026-10-04T08:10+09:00")

    def test_month_and_year_rollovers(self):
        for now, expected in (
            ("2026-11-01T00:01+09:00", "2026-10-31T20:30+09:00"),
            ("2027-01-01T00:01+09:00", "2026-12-31T20:30+09:00"),
        ):
            with self.subTest(now=now):
                self.assert_slot(now, expected)

    def test_custom_grace_can_cross_more_than_one_day(self):
        with patch.object(verify, "GRACE_MINUTES", 1500):
            self.assert_slot("2026-10-04T00:01+09:00", "2026-10-02T20:30+09:00")

    def test_empty_schedule_has_no_target(self):
        with patch.object(verify, "SLOTS", []):
            self.assertIsNone(verify.target_slot(datetime(2026, 10, 4, tzinfo=verify.JST)))

    def test_naive_datetime_is_rejected(self):
        with self.assertRaises(ValueError):
            verify.target_slot(datetime(2026, 10, 4))

    def test_utc_due_key_for_previous_evening(self):
        slot = verify.target_slot(datetime.fromisoformat("2026-10-04T00:01+09:00"))
        self.assertEqual(verify.utc_key(slot), "2026-10-03T11:30:00.000Z")


class MainRegressionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.output = Path(directory.name) / "health" / "publish_verification.json"
        posts = Path(directory.name) / "posts.json"
        posts.write_text(json.dumps([{"id": "TEST-PM", "type": "test", "text": "test post"}]), encoding="utf-8")
        frozen_now = datetime.fromisoformat("2026-10-04T00:01:22+09:00")

        class FrozenDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                return frozen_now.astimezone(tz) if tz else frozen_now.replace(tzinfo=None)

        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(verify, "datetime", FrozenDatetime))
        self.stack.enter_context(patch.object(verify, "GRACE_MINUTES", 25))
        self.stack.enter_context(patch.object(verify, "POSTS_PATH", posts))
        self.stack.enter_context(patch.object(verify, "OUT_PATH", self.output))
        self.stack.enter_context(patch.object(verify, "select_channel", return_value=({"id": "org"}, {"id": "channel"})))
        self.fetch = self.stack.enter_context(patch.object(verify, "fetch_posts"))
        # Any accidental real Buffer call must fail before it reaches the network.
        self.stack.enter_context(patch.object(verify, "gql", side_effect=AssertionError("Network forbidden in tests")))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.post = {
            "id": "post-id", "text": "test post", "status": "sent",
            "dueAt": "2026-10-03T11:30:00.000Z",
            "sentAt": "2026-10-03T11:30:02.000Z", "externalLink": "https://example.com/post",
        }

    def payload(self):
        return json.loads(self.output.read_text(encoding="utf-8"))

    def test_midnight_run_verifies_previous_evening_and_persists(self):
        self.fetch.return_value = ([self.post], [])
        verify.main()
        record = self.payload()["latest"]
        self.assertEqual(record["slot"], "2026-10-03T20:30+09:00")
        self.assertTrue(record["ok"])
        self.assertEqual(record["bufferPostId"], "post-id")
        self.assertEqual(record["contentId"], "TEST-PM")
        self.fetch.assert_called_once_with("org", "channel")

    def test_repeated_verification_replaces_same_slot_without_duplicate(self):
        earlier = {"slot": "2026-10-03T12:20+09:00", "ok": True}
        verify.save_history({"latest": earlier, "history": [earlier]})
        self.fetch.return_value = ([self.post], [])
        verify.main()
        verify.main()
        payload = self.payload()
        self.assertEqual([record["slot"] for record in payload["history"]], [earlier["slot"], "2026-10-03T20:30+09:00"])
        self.assertEqual(self.fetch.call_count, 2)

    def test_missing_previous_evening_post_fails_instead_of_green_skip(self):
        self.fetch.return_value = ([], [])
        with self.assertRaises(SystemExit) as exc:
            verify.main()
        self.assertEqual(exc.exception.code, 1)
        self.assertFalse(self.payload()["latest"]["ok"])
        self.assertIn("No sent or scheduled post", self.payload()["latest"]["errors"][0])

    def test_overdue_scheduled_post_fails(self):
        self.fetch.return_value = ([], [{**self.post, "status": "scheduled", "sentAt": None}])
        with self.assertRaises(SystemExit) as exc:
            verify.main()
        self.assertEqual(exc.exception.code, 1)
        self.assertFalse(self.payload()["latest"]["ok"])
        self.assertIn("still scheduled", self.payload()["latest"]["errors"][0])

    def test_duplicate_sent_posts_fail(self):
        self.fetch.return_value = ([self.post, {**self.post, "id": "second-post"}], [])
        with self.assertRaises(SystemExit) as exc:
            verify.main()
        self.assertEqual(exc.exception.code, 1)
        self.assertFalse(self.payload()["latest"]["ok"])
        self.assertIn("Multiple sent posts", self.payload()["latest"]["errors"][0])


if __name__ == "__main__":
    unittest.main()
