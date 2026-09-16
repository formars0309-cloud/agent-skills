"""컷 프롬프트 조립·버전·채택 도구 검사. 실제 이미지 생성은 호출하지 않는다."""
import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('panel', BASE / 'tools/panel.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class PanelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.template = m.read_json(BASE / 'tests/fixtures/프롬프트-템플릿-시험.json')
        for ref in [self.template['characters']['마왕']['sheet'], self.template['characters']['세렌']['sheet'],
                    self.template['style_reference']['path']]:
            (self.root / ref).parent.mkdir(parents=True, exist_ok=True)
            Image.new('RGB', (8, 8)).save(self.root / ref)
        self.data = {'project': self.template['project'], 'episode': 3, 'panels': [
            {'id': '01', 'scene': '[공용 정원] 장면', 'cast': ['마왕', '세렌'], 'prompt': 'King asks. Composition: medium.',
             'dialogue': ['자막: 며칠 뒤', '마왕: 차를 가져올까?', '세렌: (그냥…)'], 'source': '', 'output': ''},
            {'id': '02', 'scene': '[신전 기도실] 장면', 'cast': ['세렌'], 'prompt': 'Seren looks up.',
             'dialogue': ['마왕 목소리: 짐은 마왕이다.'], 'extra_refs': [{'panel': '01', 'note': 'previous panel'}],
             'source': '', 'output': ''}]}
        self.dir = self.root / '원고/3화-v09'
        self.manifest = self.root / 'manifest.json'
        m.write_json(self.manifest, self.data)

    def test_prompt_has_all_refs_and_lines(self):
        prompt, refs = m.assemble(self.root, self.data, '01', self.template, self.dir)
        self.assertEqual(len(refs), 3)
        self.assertEqual(prompt.count('\nImage '), 3)
        self.assertIn('Image 1:', prompt)
        self.assertIn('Image 3: a finished panel', prompt)
        self.assertIn('- "차를 가져올까?" (characters: 차, 를, space, 가, 져, 올, 까, ?) in a white speech bubble with a tail pointing to the king.', prompt)
        self.assertIn('thought bubble near Seren', prompt)
        self.assertIn('caption box', prompt)
        self.assertIn('Scene: the shared garden', prompt)
        self.assertIn('the Demon King: adult man', prompt)

    def test_no_dialogue_and_unknown_speaker(self):
        self.data['panels'][0]['dialogue'] = []
        prompt, _ = m.assemble(self.root, self.data, '01', self.template, self.dir)
        self.assertIn(self.template['no_text'], prompt)
        self.data['panels'][0]['dialogue'] = ['용사: 안녕']
        with self.assertRaises(ValueError):
            m.assemble(self.root, self.data, '01', self.template, self.dir)
        self.data['panels'][0]['dialogue'] = ['세렌: 안녕']
        self.data['panels'][0]['cast'] = ['마왕']
        with self.assertRaises(ValueError):
            m.assemble(self.root, self.data, '01', self.template, self.dir)

    def test_panel_reference_requires_adoption(self):
        with self.assertRaises(ValueError):
            m.assemble(self.root, self.data, '02', self.template, self.dir)
        self.data['panels'][0]['source'] = self.template['characters']['마왕']['sheet']
        prompt, refs = m.assemble(self.root, self.data, '02', self.template, self.dir)
        self.assertEqual(len(refs), 3)
        self.assertIn('black rounded speech box', prompt)

    def test_versions_and_dry_run_writes_prompt(self):
        (self.dir / '원본').mkdir(parents=True)
        Image.new('RGB', (8, 8)).save(self.dir / '원본/01.png')
        Image.new('RGB', (8, 8)).save(self.dir / '원본/01-v3.png')
        self.assertEqual(sorted(m.versions(self.dir, '01')), [1, 3])
        self.assertEqual(m.next_version(self.dir, '01'), 4)
        args = argparse.Namespace(dir='원고/3화-v09', panel='01', backend='grok', edit=None, instruction=None,
                                  timeout=None, dry_run=True)
        self.assertEqual(m.generate(self.root, self.data, self.template, args), 0)
        refs = (self.dir / '프롬프트/01-v4.refs').read_text().splitlines()
        self.assertEqual(len(refs), 3)
        self.assertTrue((self.dir / '프롬프트/01-v4.txt').exists())
        self.assertFalse((self.dir / '생성기록.jsonl').exists())

    def test_adopt_preserves_unversioned_slot_and_records(self):
        for folder in ('원본', '업로드'):
            (self.dir / folder).mkdir(parents=True)
        Image.new('RGB', (8, 8), 'red').save(self.dir / '업로드/01.jpg')
        Image.new('RGB', (8, 8)).save(self.dir / '원본/01-v2.png')
        Image.new('RGB', (8, 8), 'blue').save(self.dir / '업로드/01-v2.jpg')
        args = argparse.Namespace(dir='원고/3화-v09', panel='01', version=2)
        m.adopt(self.root, self.data, args, self.manifest)
        saved = m.read_json(self.manifest)['panels'][0]
        self.assertEqual(saved['source'], '원고/3화-v09/원본/01-v2.png')
        self.assertEqual(saved['output'], '원고/3화-v09/업로드/01.jpg')
        self.assertEqual(saved['adopted']['version'], 2)
        self.assertEqual(m.sha256(self.dir / '업로드/01.jpg'), m.sha256(self.dir / '업로드/01-v2.jpg'))
        self.assertTrue((self.dir / '업로드/01-v3.jpg').exists(), '기존 슬롯 파일은 새 버전 이름으로 보존')
        with self.assertRaises(ValueError):
            m.adopt(self.root, self.data, argparse.Namespace(dir='원고/3화-v09', panel='01', version=9), self.manifest)


if __name__ == '__main__':
    unittest.main()


class TwoStageTests(PanelTests):
    def test_verdict_and_selection(self):
        (self.dir / '원본').mkdir(parents=True)
        Image.new('RGB', (8, 8)).save(self.dir / '원본/01-v1.png')
        with self.assertRaises(ValueError):
            m.verdict(self.root, self.data, argparse.Namespace(dir='원고/3화-v09', panel='01', version=2, result='통과', note='x'), self.manifest)
        m.verdict(self.root, self.data, argparse.Namespace(dir='원고/3화-v09', panel='01', version=1, result='수정', note='세렌 몸 방향'), self.manifest)
        self.assertEqual(m.select_batch(self.data, 'final', set()), ([], [('01', '최신 시안 v1 수정'), ('02', '통과한 시안 없음')]))
        self.assertEqual(m.select_batch(self.data, 'draft', set())[0], ['01', '02'])
        m.verdict(self.root, self.data, argparse.Namespace(dir='원고/3화-v09', panel='01', version=1, result='통과', note='구도 확인'), self.manifest)
        self.assertEqual(m.select_batch(self.data, 'final', set())[0], ['01'])
        self.assertEqual(m.select_batch(self.data, 'draft', set()), (['02'], [('01', '시안 v1 통과됨')]))
        self.data['panels'][0]['adopted'] = {'version': 2}
        self.assertEqual(m.select_batch(self.data, 'final', set())[0], [])
        self.assertEqual(m.select_batch(self.data, 'final', {'01'}, force=True)[0], ['01'])
        self.assertEqual(len(m.read_json(self.manifest)['panels'][0]['drafts']), 2)

    def test_draft_stage_uses_latest_version_of_unadopted_reference(self):
        (self.dir / '원본').mkdir(parents=True)
        Image.new('RGB', (8, 8)).save(self.dir / '원본/01-v1.png')
        Image.new('RGB', (8, 8)).save(self.dir / '원본/01-v2.png')
        with self.assertRaises(ValueError):
            m.assemble(self.root, self.data, '02', self.template, self.dir, 'final')
        _, refs = m.assemble(self.root, self.data, '02', self.template, self.dir, 'draft')
        self.assertEqual(refs[-1].name, '01-v2.png')

    def test_batch_dry_run_parallel_versions_do_not_collide(self):
        self.data['panels'][1]['extra_refs'] = []
        args = argparse.Namespace(dir='원고/3화-v09', stage='draft', panels=None, backend=None, jobs=2,
                                  force=False, timeout=None, dry_run=True)
        self.assertEqual(m.batch(self.root, self.data, self.template, args), 0)
        self.assertTrue((self.dir / '프롬프트/01-v1.txt').exists())
        self.assertTrue((self.dir / '프롬프트/02-v1.txt').exists())
        self.assertEqual(len((self.dir / '프롬프트/02-v1.refs').read_text().splitlines()), 2)
        self.assertFalse((self.dir / '생성기록.jsonl').exists())


class OcrAndScreenTests(PanelTests):
    def frag(self, text, y, x=0.1):
        return {'text': text, 'confidence': 0.9, 'box': [x, y, 0.2, 0.03]}

    def test_compare_text_joins_fragments_per_bubble(self):
        expected = ['내일은 무슨 차를 가져올까?', '그냥 아무거나요.', '며칠 뒤, 공용 정원']
        frags = [self.frag('며칠 뒤, 공용 정원', 0.05), self.frag('내일은 무슨', 0.14, 0.36), self.frag('그냥', 0.15, 0.78),
                 self.frag('차를 가져올까?', 0.18, 0.36), self.frag('아무거나요.', 0.19, 0.78)]
        results, summary = m.compare_text(expected, frags)
        self.assertEqual([r['state'] for r in results], ['found'] * 3)
        self.assertEqual(summary['missing'], [])
        self.assertEqual(summary['extra'], [])

    def test_compare_text_reports_missing_partial_and_extra(self):
        expected = ['(세 번 다 ‘아무거나’. …설마 거절인가.)', '정식 절차를 밟겠다.']
        frags = [self.frag("(세 번 다 '아무거나'.", 0.5), self.frag('•설마 거절인가.)', 0.54), self.frag('HELLO', 0.9)]
        results, summary = m.compare_text(expected, frags)
        self.assertEqual(results[0]['state'], 'found', '문장부호 차이는 무시')
        self.assertEqual(results[1]['state'], 'missing')
        self.assertEqual(summary['missing'], ['정식 절차를 밟겠다.'])
        self.assertEqual(summary['extra'], ['HELLO'])
        results, _ = m.compare_text(['정식 절차를 밟겠다.'], [self.frag('정식 절차를', 0.1)])
        self.assertEqual(results[0]['state'], 'partial')

    def test_screen_targets_prefer_adopted_then_latest(self):
        for folder in ('원본', '업로드'):
            (self.dir / folder).mkdir(parents=True)
        for name in ('01-v1', '01-v2'):
            Image.new('RGB', (8, 8)).save(self.dir / f'원본/{name}.png')
            Image.new('RGB', (8, 8)).save(self.dir / f'업로드/{name}.jpg')
        targets = m.screen_targets(self.root, self.data, self.dir, set())
        self.assertEqual([(t[0], t[1].name, t[2]) for t in targets], [('01', '01-v2.jpg', 'v2')])
        Image.new('RGB', (8, 8)).save(self.dir / '업로드/01.jpg')
        self.data['panels'][0]['output'] = '원고/3화-v09/업로드/01.jpg'
        targets = m.screen_targets(self.root, self.data, self.dir, {'01'})
        self.assertEqual((targets[0][1].name, targets[0][2]), ('01.jpg', '채택본'))
