"""제작 검수의 변경 감지·단계 차단·실제 납품 파일 검사."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from PIL import Image

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('production', BASE / 'tools/production.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = p.read(BASE / 'templates/project.json')
        (self.root / '기준.md').write_text('기준')
        self.data = {'schema': 1, 'project': self.config['project'], 'episode': 3,
                     'brief': dict.fromkeys(['premise', 'turn', 'ending', 'research_note'], '검토함'),
                     'references': ['기준.md'], 'schedule': {}, 'panels': [], 'reviews': []}
        for i in range(1, 3):
            Image.new('RGB', (690, 400), 'white').save(self.root / f'{i:02}.jpg')
            Image.new('RGB', (1024, 600)).save(self.root / f'{i:02}.png')
            self.data['panels'].append({'id': f'{i:02}', 'scene': '장면', 'emotion': '당황',
                'shot': '중경', 'owner': '담당자', 'dialogue': [],
                'source': f'{i:02}.png', 'output': f'{i:02}.jpg'})

    def accept(self, target):
        p.prerequisites(self.root, self.data, self.config, target)
        self.data['reviews'].append({'target': target, 'reviewer': '검수자', 'note': '확인',
            'checks': p.checklist(self.config, target),
            'fingerprint': p.fingerprint(self.root, self.data, self.config, target)})

    def ready(self):
        for target in ['brief', 'storyboard', '01', '02']:
            self.accept(target)

    def test_complete_delivery(self):
        self.ready()
        r = p.report(self.root, self.data, self.config, 'delivery')
        self.assertTrue(r['ready'])
        self.assertGreater(r['bytes'], 0)

    def test_blank_brief_and_premature_review(self):
        self.data['brief']['turn'] = ''
        self.assertFalse(p.report(self.root, self.data, self.config, 'brief')['ready'])
        with self.assertRaises(ValueError):
            self.accept('01')

    def test_one_cut_change_preserves_other_cut(self):
        self.ready()
        self.data['panels'][0]['dialogue'] = ['수정 대사']
        self.assertEqual(p.report(self.root, self.data, self.config, 'production')['pending'], ['storyboard', '01'])

    def test_reference_change_invalidates_everything(self):
        self.ready()
        (self.root / '기준.md').write_text('새 기준')
        self.assertEqual(len(p.report(self.root, self.data, self.config, 'production')['pending']), 4)

    def test_image_change_invalidates_only_cut(self):
        self.ready()
        Image.new('RGB', (690, 400), 'red').save(self.root / '01.jpg')
        self.assertEqual(p.report(self.root, self.data, self.config, 'production')['pending'], ['01'])

    def test_deleted_source_is_pending(self):
        self.ready()
        (self.root / '01.png').unlink()
        self.assertIn('01', p.report(self.root, self.data, self.config, 'production')['pending'])

    def test_wrong_project_sequence_and_escape(self):
        self.data['project'] = '다른 작품'
        with self.assertRaises(ValueError):
            p.validate(self.data, self.config)
        self.data['project'] = self.config['project']
        self.data['panels'][1]['id'] = '01'
        with self.assertRaises(ValueError):
            p.validate(self.data, self.config)
        with self.assertRaises(ValueError):
            p.path(self.root, '../외부')

    def test_image_format_width_and_limits(self):
        for size, fmt in [((500, 400), 'JPEG'), ((690, 400), 'PNG')]:
            Image.new('RGB', size).save(self.root / '01.jpg', format=fmt)
            with self.assertRaises(ValueError):
                p.delivery(self.root, self.data, self.config)
        Image.new('RGB', (690, 400)).save(self.root / '01.jpg')
        config = copy.deepcopy(self.config)
        config['delivery']['file_bytes_exclusive'] = (self.root / '01.jpg').stat().st_size
        with self.assertRaises(ValueError):
            p.delivery(self.root, self.data, config)
        config = copy.deepcopy(self.config)
        config['delivery']['episode_bytes_inclusive'] = 1
        with self.assertRaises(ValueError):
            p.delivery(self.root, self.data, config)

    def test_schedule_does_not_invalidate_art(self):
        self.ready()
        self.data['schedule']['deadline'] = '2026-10-01'
        self.assertTrue(p.report(self.root, self.data, self.config, 'delivery')['ready'])

    def test_refuse_overwrite(self):
        target = self.root / '기준.md'
        with self.assertRaises(FileExistsError):
            p.create(target, {})
        self.assertEqual(target.read_text(), '기준')

    def test_cli_init_check_review_and_import(self):
        # 실제 CLI를 독립 임시 저장소에서 실행한다.
        import shutil
        (self.root / 'tools').mkdir()
        (self.root / 'production').mkdir()
        shutil.copyfile(BASE / 'tools/production.py', self.root / 'tools/production.py')
        config = copy.deepcopy(self.config)
        config['references'] = ['기준.md']
        p.create(self.root / 'production/project.json', config)
        def run(*args):
            return subprocess.run([sys.executable, str(self.root / 'tools/production.py'), *args], capture_output=True, text=True, cwd=self.root)
        p.create(self.root / 'old.json', {'panel_specs': [{'scene':'장면','text':['안녕'],'emotion':'기쁨','shot':'중경'}]})
        self.assertEqual(run('init','production/ep.json','--episode','3','--from-storyboard','old.json').returncode, 0)
        self.assertEqual(run('init','production/ep.json','--episode','3').returncode, 1)
        self.assertEqual(run('check','production/ep.json','--stage','brief').returncode, 1)
        manifest = self.root / 'production/ep.json'
        data = p.read(manifest)
        self.assertEqual(data['panels'][0]['dialogue'], ['안녕'])
        data['brief'] = self.data['brief']
        manifest.write_text(json.dumps(data))
        args = ['review','production/ep.json','--target','brief','--reviewer','검수자','--note','확인']
        self.assertEqual(run(*args).returncode, 1)
        for check in config['checks']['brief']:
            args += ['--confirm', check]
        self.assertEqual(run(*args).returncode, 0)
        self.assertEqual(p.read(manifest)['reviews'], [])
        self.assertEqual(run('check','production/ep.review-1.json','--stage','brief').returncode, 0)


if __name__ == '__main__':
    unittest.main()
