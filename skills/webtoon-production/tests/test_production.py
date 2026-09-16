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

    def test_story_policy_does_not_change_existing_reviews(self):
        self.ready()
        before = p.fingerprint(self.root, self.data, self.config, '01')
        (self.root / 'production').mkdir()
        p.create(self.root / 'production/story-policy.json',
                 {'version': 1, 'from_episode': 1, 'guide': '서사.md'})
        (self.root / '서사.md').write_text('신규 회차 안내')
        self.assertEqual(before, p.fingerprint(self.root, self.data, self.config, '01'))
        self.assertTrue(p.report(self.root, self.data, self.config, 'delivery')['ready'])

    def test_new_story_record_blocks_review_until_filled_and_detects_change(self):
        self.data['brief']['story'] = dict.fromkeys(p.STORY_FIELDS, '')
        with self.assertRaises(ValueError):
            self.accept('brief')
        self.assertIn('brief.story.canon', p.report(self.root, self.data, self.config, 'brief')['story_record'])
        self.data['brief']['story'] = dict.fromkeys(p.STORY_FIELDS, '검토 근거')
        self.ready()
        self.data['schedule']['story_metrics'] = {'documentation_minutes': 5}
        self.assertTrue(p.report(self.root, self.data, self.config, 'delivery')['ready'])
        self.data['brief']['story']['knowledge'] = '독자만 알고 인물은 모르는 정보로 수정'
        self.assertEqual(p.report(self.root, self.data, self.config, 'production')['pending'],
                         ['brief', 'storyboard', '01', '02'])

    def test_story_init_applies_only_from_configured_episode(self):
        (self.root / 'production').mkdir()
        config = copy.deepcopy(self.config)
        config['references'] = ['기준.md']
        p.create(self.root / 'production/project.json', config)
        p.create(self.root / 'production/story-policy.json',
                 {'version': 1, 'from_episode': 4, 'guide': '서사.md'})
        (self.root / '서사.md').write_text('작품 예외')
        for episode in [3, 4]:
            result = subprocess.run([sys.executable, str(BASE / 'tools/production.py'),
                '--root', str(self.root), 'init', f'production/{episode}.json',
                '--episode', str(episode)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = p.read(self.root / f'production/{episode}.json')
            self.assertEqual('story' in data['brief'], episode == 4)
            self.assertEqual('서사.md' in data['references'], episode == 4)
            self.assertEqual(data['reviews'], [])
        self.assertEqual(p.read(self.root / 'production/project.json'), config)

    def test_story_guide_escape_and_bad_record_rejected(self):
        (self.root / 'production').mkdir()
        p.create(self.root / 'production/story-policy.json',
                 {'version': 1, 'from_episode': 1, 'guide': '../외부.md'})
        with self.assertRaises(ValueError):
            p.init_story(self.root, self.data)
        self.data['brief']['story'] = '형식 오류'
        with self.assertRaises(ValueError):
            self.accept('brief')

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
