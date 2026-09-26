"""작품 연결 스크립트가 AGENTS.md에 도구 안내를 중복으로 붙이지 않는지 확인한다."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[1]
SCRIPT = BASE / 'tools/setup_project.py'
MARK = '## 회차 제작 도구 — webtoon-production'


def run(root):
    return subprocess.run([sys.executable, str(SCRIPT), str(root), '--name', '테스트작'],
                          capture_output=True, text=True, check=True).stdout


class AgentsSectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.agents = self.root / 'AGENTS.md'

    def test_adds_section_once(self):
        self.agents.write_text('# 작품\n', encoding='utf-8')
        run(self.root)
        run(self.root)
        self.assertEqual(self.agents.read_text(encoding='utf-8').count(MARK), 1)

    def test_keeps_rewritten_guide_without_mark(self):
        text = '# 작품\n\n- `tools/`는 `~/Projects/agent-skills/skills/webtoon-production/` 한 벌을 공유한다.\n'
        self.agents.write_text(text, encoding='utf-8')
        out = run(self.root)
        self.assertEqual(self.agents.read_text(encoding='utf-8'), text)
        self.assertIn('유지:', out)


if __name__ == '__main__':
    unittest.main()
