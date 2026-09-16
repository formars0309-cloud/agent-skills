"""격리된 임시 파일로 읽기 전용 조사와 보호 경계를 검증한다."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from inventory import digest, fingerprint, scan


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / '콘텐츠 프로젝트'
        self.root.mkdir()

    def test_duplicates_and_preservation(self):
        for name, data in [('정본.png', b'original'), ('시안.png', b'original'), ('다른.png', b'different')]:
            (self.root / name).write_bytes(data)
        report = scan([self.root], True)
        self.assertEqual(len(report['duplicate_candidates']), 1)
        self.assertEqual(len(report['files']), 3)
        self.assertEqual((self.root / '시안.png').read_bytes(), b'original')
        self.assertEqual(report['errors'], [])

    def test_protected_paths_and_symlinks(self):
        (self.root / '.env').write_text('dummy')
        (self.root / 'private.pem').write_text('dummy')
        (self.root / '.git').mkdir()
        (self.root / '.git' / 'dummy').write_text('dummy')
        outside = self.base / '외부'
        outside.mkdir()
        (outside / '원본').write_text('dummy')
        (self.root / 'link').symlink_to(outside, target_is_directory=True)
        (self.root / 'file-link').symlink_to(outside / '원본')
        report = scan([self.root], True)
        self.assertEqual(report['files'], [])
        self.assertEqual(len(report['skipped']), 5)

    def test_changed_file_rejected(self):
        path = self.root / '시안'
        path.write_bytes(b'a')
        before = fingerprint(path.stat())
        path.write_bytes(b'changed')
        with self.assertRaises(ValueError):
            digest(path, before)

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(Path(__file__).with_name('inventory.py')), *args],
                              capture_output=True, text=True)

    def test_report_and_nested_roots(self):
        child = self.root / '하위'
        child.mkdir()
        (child / '파일').write_text('hello')
        output = self.base / 'report.json'
        result = self.run_cli('--root', str(child), '--root', str(self.root), '--output', str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(output.read_text())
        self.assertEqual(len(report['files']), 1)
        self.assertEqual(len(report['roots']), 1)
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertNotEqual(self.run_cli('--root', str(self.root), '--output', str(output)).returncode, 0)

    def test_unsafe_output_and_symlink_root_rejected(self):
        self.assertNotEqual(self.run_cli('--root', str(self.root), '--output', str(self.root / 'report.json')).returncode, 0)
        link = self.base / 'root-link'
        link.symlink_to(self.root, target_is_directory=True)
        self.assertNotEqual(self.run_cli('--root', str(link), '--output', str(self.base / 'report.json')).returncode, 0)


if __name__ == '__main__':
    unittest.main()
