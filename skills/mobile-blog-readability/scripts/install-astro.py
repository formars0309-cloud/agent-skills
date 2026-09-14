"""정본 표시기를 Astro 저장소에 배포용 사본으로 내보낸다. 직접 편집은 정본에서 한다."""
from pathlib import Path
import argparse
import hashlib
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('project', type=Path)
args = parser.parse_args()
source = Path(__file__).resolve().parents[1] / 'assets/rehype-mobile-readability.mjs'
data = source.read_text()
target = args.project / 'scripts/rehype-mobile-readability.mjs'
target.parent.mkdir(parents=True, exist_ok=True)
exported = ('// 생성 파일: mobile-blog-readability 전역 스킬에서 내보냄.\n'
            '// 정본 SHA-256: ' + hashlib.sha256(source.read_bytes()).hexdigest() + '\n' + data)
changed = not target.exists() or target.read_text() != exported
target.write_text(exported)
tests_source = source.parents[1] / 'scripts/readability.test.mjs'
tests = tests_source.read_text().replace("'../assets/rehype-mobile-readability.mjs'", "'./rehype-mobile-readability.mjs'")
(target.parent / 'mobile-readability.test.mjs').write_text('// 생성 파일: mobile-blog-readability 전역 스킬의 회귀 검사.\n' + tests)
if changed:
    for relative in ['node_modules/.astro', 'node_modules/.vite']:
        cache = args.project / relative
        if cache.is_dir():
            shutil.rmtree(cache)
            print('표시기 변경으로 재생성 캐시 정리:', cache)
print(target)
