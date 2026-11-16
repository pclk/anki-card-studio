"""Review regressions: local companion tombstone/revision parity with the hosted API."""
import json
import unittest
from local_test import LocalHTTP as Base


class ReviewLocal(Base):
    def test_deleted_project_needs_explicit_restore(self):
        self.assertEqual(self.request('project/p', 'PUT', b'{"rev":1}')[0], 200)
        self.assertEqual(self.request('project/p', 'DELETE')[0], 200)
        self.assertEqual(self.request('project/p', 'PUT', b'{"rev":2}')[0], 410)
        self.assertEqual(self.request('project/p', 'PUT', b'{"rev":2}', {'X-ACS-Restore': '1'})[0], 200)
        self.assertEqual(self.request('project/p', 'PUT', b'{"rev":3}', {'X-ACS-Base-Rev': '2'})[0], 200)

    def test_failed_restore_keeps_tombstone(self):
        self.request('project/p', 'PUT', b'{"rev":1}'); self.request('project/p', 'DELETE')
        self.assertEqual(self.request('project/p', 'PUT', b'{"rev":"x"}', {'X-ACS-Restore': '1'})[0], 400)
        self.assertIn('p', self.app.deleted())

    def test_revision_shapes_match_hosted(self):
        for body in [b'{"rev":true}', b'{"rev":-1}', b'{"rev":2147483648}', b'[]', b'null']:
            self.assertEqual(self.request('project/s', 'PUT', body)[0], 400, body)
        self.request('project/s', 'PUT', b'{"rev":5}')
        for base in ['1e3', '-1', 'x', '²']:
            self.assertEqual(self.request('project/s', 'PUT', b'{"rev":6}', {'X-ACS-Base-Rev': base})[0], 400, base)
        self.assertEqual(self.request('project/s', 'PUT', b'{"rev":5}', {'X-ACS-Base-Rev': '5'})[0], 400)
        self.assertEqual(json.loads(self.request('project/s/rev')[1])['rev'], 5)


del Base
if __name__ == '__main__':
    unittest.main()
