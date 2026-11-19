"""Local companion HTTP regression suite; never touches personal data."""
import importlib.util
import json
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('acs', Path(__file__).resolve().parents[1] / 'local/acs.py')
acs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acs)
class LocalHTTP(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = acs.App(Path(self.tmp.name)/'data', 0, Path('local').resolve())
        self.server = acs.ThreadingHTTPServer(('127.0.0.1',0), acs.make_handler(self.app))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}/api/'
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.tmp.cleanup()
    def request(self, path, method='GET', body=None, headers=None):
        req = urllib.request.Request(self.base+path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req) as r: return r.status, r.read()
        except urllib.error.HTTPError as e: return e.code, e.read()
    def test_project_lifecycle(self):
        self.assertEqual(self.request('project/p','PUT',b'{"rev":1}')[0],200)
        self.assertEqual(json.loads(self.request('project/p')[1])['rev'],1)
        self.assertEqual(self.request('project/p','PUT',b'{"rev":2}',{'X-ACS-Base-Rev':'0'})[0],409)
        self.assertEqual(self.request('project/p','DELETE')[0],200)
        self.assertEqual(self.request('project/p')[0],404)
    def test_media_lifecycle(self):
        path='project/p/media/a.png'
        self.assertEqual(self.request(path,'PUT',b'png')[0],200)
        self.assertEqual(self.request(path)[1],b'png')
        self.assertEqual(json.loads(self.request('project/p/media')[1]),['a.png'])
        self.assertEqual(self.request(path,'DELETE')[0],200)
        self.assertEqual(self.request(path)[0],404)
    def test_cross_origin(self):
        self.assertEqual(self.request('settings','PUT',b'{}',{'Origin':'https://evil.test'})[0],403)
    def test_folder_boundary(self):
        with patch.object(acs,'open_in_file_manager') as opened:
            for path in ['../data-other','../../outside']:
                self.assertEqual(self.request('open?path='+path,'POST')[0],403)
            opened.assert_not_called()
    def test_settings(self):
        self.assertEqual(self.request('settings')[1],b'null')
        self.assertEqual(self.request('settings','PUT',b'{"version":2}')[0],200)
        self.assertEqual(json.loads(self.request('settings')[1]),{'version':2})
    def test_deleted_index_does_not_resurrect(self):
        entry=b'[{"id":"p","updated":1}]'
        self.request('projects','PUT',entry)
        self.request('project/p','DELETE')
        self.assertEqual(json.loads(self.request('projects','PUT',entry)[1]),[])
    def test_path_traversal(self):
        for path in ['project/a%2fb','project/p/media/..%2fx']:
            self.assertEqual(self.request(path,'PUT',b'{}')[0],403)
    def test_skill_download(self):
        import io, zipfile
        root = self.base[:-len('api/')]
        with urllib.request.urlopen(root + 'skill/anki.zip') as r:
            self.assertEqual(r.headers['Content-Type'], 'application/zip')
            z = zipfile.ZipFile(io.BytesIO(r.read()))
        self.assertEqual(sorted(z.namelist()), ['anki/SKILL.md', 'anki/scripts/anki_helper.py', 'anki/scripts/extract.py', 'anki/scripts/make_prompts.py'])
        self.assertEqual(z.read('anki/SKILL.md'), (Path('skill/anki/SKILL.md')).read_bytes())
        with urllib.request.urlopen(root + 'skill/anki_helper.py') as r:
            self.assertEqual(r.read(), Path('skill/anki/scripts/anki_helper.py').read_bytes())
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(root + 'skill/..%2Facs.py')
        self.assertEqual(e.exception.code, 404)
    def test_skill_from_the_built_studio(self):
        # outside the repo there is no skill/ folder: the copy built into the Studio .html is served
        app = acs.App(Path(self.tmp.name)/'data2', 0, Path(self.tmp.name)/'elsewhere'/'local')
        (app.data/'apps').mkdir(parents=True, exist_ok=True)
        (app.data/'apps'/'studio.html').write_text('<script type="text/plain" id="skillSrc">\n---\nname: anki\n</script>')
        self.assertEqual(app.skill_file('SKILL.md'), b'---\nname: anki\n')
        with self.assertRaises(FileNotFoundError):
            app.skill_file('extract.py')
    def test_unknown(self):
        self.assertEqual(self.request('unknown')[0],404)
if __name__ == '__main__': unittest.main()
