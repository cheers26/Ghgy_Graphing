from __future__ import annotations
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TEXT = {'.html', '.js', '.json', '.md', '.css', '.svg', '.txt', '.yml', '.yaml'}

def chars(*values: int) -> str:
    return ''.join(chr(value) for value in values)

blocked_literals = [
    chars(121,117,97,110,100,97,110),
    chars(34945,20025),
]
internal_categories = '|'.join([
    chars(73,70,73,78,68), chars(87,73,78,68), chars(83,77,77),
    chars(66,76,79,79,77,66,69,82,71), chars(68,69,82,73,86,69,68),
    chars(83,73,78,71,76,69), chars(83,89,83,84,69,77),
])
blocked_patterns = [
    re.compile(r'(?<![A-Z0-9])(?:' + chars(80,73) + '|' + chars(80,67) + r')-[A-F0-9]{12,}(?![A-Z0-9])', re.I),
    re.compile(r'(?<![A-Z0-9])(?:' + chars(89,68) + '|' + chars(83,67) + '|' + chars(67,72) + r')-(?:' + internal_categories + r')-[A-Z0-9-]+(?![A-Z0-9])', re.I),
    re.compile(re.escape(chars(47,85,115,101,114,115,47)), re.I),
    re.compile(r'[^\s"\'<>]+\.' + chars(120,108,115) + r'[xm]?\b', re.I),
]
blocked_fields = [
    'source' + '_' + 'system', 'publisher', 'external' + '_' + 'id',
    'logical' + '_' + 'work' + 'book' + '_' + 'id', 'source' + '_' + 'file' + '_' + 'id',
    'source' + '_' + 'sheet', 'source' + '_' + 'column', 'original' + '_' + 'path',
    'snapshot' + '_' + 'path', 'identity' + '_' + 'key',
]

findings = []
for path in sorted(ROOT.rglob('*')):
    if not path.is_file() or path.suffix.lower() not in TEXT:
        continue
    text = path.read_text(encoding='utf-8', errors='ignore')
    relative = path.relative_to(ROOT).as_posix()
    if any(value.casefold() in text.casefold() for value in blocked_literals):
        findings.append((relative, 'identity'))
    if any(pattern.search(text) for pattern in blocked_patterns):
        findings.append((relative, 'technical_value'))
    if any(re.search(r'["\']' + re.escape(field) + r'["\']\s*:', text) for field in blocked_fields):
        findings.append((relative, 'internal_field'))

manifest = json.loads((ROOT / 'PUBLIC_MANIFEST.json').read_text(encoding='utf-8'))
for relative, metadata in manifest.get('files', {}).items():
    path = ROOT / relative
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != metadata.get('sha256'):
        findings.append((relative, 'integrity'))

if findings:
    for relative, kind in findings[:20]:
        print(f'blocked: {relative}: {kind}')
    raise SystemExit(1)
print('customer package audit passed')
