import copy
import importlib.util
import json
import unittest
import os
import tempfile
from unittest.mock import patch
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('collector', ROOT / 'collect_analytics.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def row(collected=25, metric=25, impressions=0):
    sent = datetime(2026, 10, 1, tzinfo=timezone.utc)
    return {'sentAt': sent.isoformat(), 'collectedAt': (sent + timedelta(hours=collected)).isoformat(),
            'metricsUpdatedAt': (sent + timedelta(hours=metric)).isoformat(), 'impressions': impressions,
            'elapsedHours': round(collected, 3), 'metricElapsedHours': round(metric, 3)}

class AgeTests(unittest.TestCase):
    def test_boundaries(self):
        for age, status in [(0,'pending'),(23.9,'pending'),(24,'captured'),(26,'captured'),(26.1,'missed_metric_window')]:
            with self.subTest(age=age): self.assertEqual(m.age_snapshot_entry(row(age,age),24)['status'],status)
    def test_actual_precision_not_rounded_age(self):
        r=row(26.00001,26.00001)
        self.assertEqual(r['metricElapsedHours'],26)
        self.assertEqual(m.age_snapshot_entry(r,24)['status'],'missed_metric_window')
    def test_delayed_valid_metric(self):
        r=row(35,25)
        out=m.age_snapshot_entry(r,24)
        self.assertEqual(out['status'],'captured_delayed')
        self.assertEqual(out['freshnessLagHours'],10)
        self.assertEqual(out['snapshot'],r)
    def test_stale_does_not_capture(self):
        self.assertEqual(m.age_snapshot_entry(row(24.619,14.536),24)['status'],'provider_stale')
    def test_stale_72_does_not_capture(self):
        self.assertEqual(m.age_snapshot_entry(row(72.615,62.531),72)['status'],'provider_stale')
    def test_72_delayed(self):
        self.assertEqual(m.age_snapshot_entry(row(84,73),72)['status'],'captured_delayed')
    def test_later_observation_can_resolve_stale(self):
        p=m.age_snapshot_entry(row(35,23),24)
        self.assertEqual(m.age_snapshot_entry(row(36,25),24,p)['status'],'captured_delayed')
    def test_never_backfill_later_current_value(self):
        self.assertEqual(m.age_snapshot_entry(row(49,48),24)['status'],'missed_metric_window')
    def test_saved_capture_unchanged(self):
        for state in ['captured','captured_delayed']:
            p={'status':state,'snapshot':row(25,25,3)}
            self.assertIs(m.age_snapshot_entry(row(80,78,100),24,p),p)
    def test_missing_metric(self):
        self.assertEqual(m.age_snapshot_entry(row(impressions=None),24)['status'],'metric_missing')
    def test_zero_valid_not_missing(self):
        self.assertEqual(m.age_snapshot_entry(row(impressions=0),24)['status'],'captured')
    def test_invalid_metric(self):
        for v in [True,float('nan'),float('inf')]:
            self.assertEqual(m.age_snapshot_entry(row(impressions=v),24)['status'],'metric_missing')
    def test_timestamp_missing(self):
        for field in ['sentAt','collectedAt','metricsUpdatedAt']:
            r=row();r.pop(field)
            self.assertEqual(m.age_snapshot_entry(r,24)['status'],'timestamp_missing')
    def test_invalid_timestamps(self):
        for v in ['invalid','2026-10-01T00:00:00',123]:
            r=row();r['metricsUpdatedAt']=v
            self.assertEqual(m.age_snapshot_entry(r,24)['status'],'invalid_timestamp')
    def test_future_timestamp(self):
        self.assertEqual(m.age_snapshot_entry(row(24,25),24)['status'],'invalid_timestamp')
    def test_prepublication_timestamp(self):
        self.assertEqual(m.age_snapshot_entry(row(24,-1),24)['status'],'invalid_timestamp')
    def test_input_not_mutated(self):
        r=row();orig=copy.deepcopy(r);m.age_snapshot_entry(r,24);self.assertEqual(r,orig)
    def test_verified_failure_examples_not_falsely_captured(self):
        # Observed 2026-10-08 provider/collector age pairs; no live-file dependency.
        for collection, metric, hours in [(24.619,14.536,24),(72.615,62.531,72)]:
            out=m.age_snapshot_entry(row(collection,metric),hours)
            self.assertIsNone(out['snapshot'])
            self.assertEqual(out['status'],'provider_stale')

class IntegrationTests(unittest.TestCase):
    def test_offline_collector_and_evaluator(self):
        # Deterministic synthetic payload; no mutable repository snapshots/network.
        data={'generatedAt':'2026-10-08T12:07:30+00:00','posts':[]}
        for i in range(28):
            r=row(100+i,14 if i == 0 else 90+i)
            r.update({'bufferPostId':str(i),'text':f'fixture {i}','externalLink':None,
                      'hasNoteLink':False,'noteDestination':None,'linkEvidence':[],
                      'rawMetrics':{'impressions':i,'clicks':0}})
            data['posts'].append(r)
        posts=[]
        for r in data['posts']:
            posts.append({'id':r['bufferPostId'],'text':r['text'],'sentAt':r['sentAt'],
                'externalLink':r['externalLink'],'metricsUpdatedAt':r['metricsUpdatedAt'],
                'metrics':[{'type':k,'value':v} for k,v in r['rawMetrics'].items()]})
        class FixedDate(datetime):
            @classmethod
            def now(cls,tz=None):
                return datetime.fromisoformat(data['generatedAt']).astimezone(tz)
        old=os.getcwd()
        with tempfile.TemporaryDirectory() as td:
            try:
                os.chdir(td)
                m.BASE.mkdir(parents=True)
                m.POSTS_PATH.write_text('[]')
                with patch.object(m,'datetime',FixedDate), patch.object(m,'select_twitter_channel',return_value=({'id':'test-org','name':'test'},{'id':'test-channel','name':'test'})), patch.object(m,'fetch_sent_posts',return_value=posts), patch.object(m,'gql',side_effect=AssertionError('Network forbidden')), patch.object(m, 'classify_links', side_effect=lambda text, cache, at: next((r['hasNoteLink'], r['noteDestination'], r['linkEvidence']) for r in data['posts'] if r['text'] == text)), patch.object(m.urllib.request, 'urlopen', side_effect=AssertionError('Network forbidden')) as network:
                    network.assert_not_called()
                    m.main()
                    network.assert_not_called()
                output=json.loads(m.POST_ANALYTICS_PATH.read_text())
                ages=json.loads(m.AGE_PATH.read_text())
                self.assertEqual(output['postCount'],28)
                self.assertIsNone(output['notePurchases'])
                self.assertIsNone(output['noteRevenueJpy'])
                self.assertEqual(ages['schemaVersion'],3)
                self.assertTrue(all(v[h]['snapshot'] is None for v in ages['posts'].values() for h in ['24','72']))
                # evaluator loaded before entering the temporary directory below
                evaluator.main()
                report=(m.ANALYTICS_DIR/'decision.md').read_text()
                self.assertIn('provider_stale',report)
                self.assertIn('missed_metric_window',report)
                self.assertIn('窓外の現在値で過去を補完しない',report)
            finally: os.chdir(old)

# Absolute module path is resolved before temporary working-directory changes.
es=importlib.util.spec_from_file_location('evaluator', ROOT.resolve()/'evaluate_analytics.py')
evaluator=importlib.util.module_from_spec(es)
es.loader.exec_module(evaluator)

if __name__=='__main__': unittest.main()
