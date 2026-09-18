#!/usr/bin/env python3
"""Print a PAGES= value listing pages of a book whose result was not produced by claude-fable-5-1."""
import glob, json, os, re, sys
folder = sys.argv[1]
cap = os.path.join(folder, 'text-capture')
pngs = sorted(int(re.search(r'page-(\d+)\.png$', p).group(1)) for p in glob.glob(os.path.join(cap, 'page-*.png')))
missing = []
for n in pngs:
    j = os.path.join(cap, f'page-{n:04d}.json')
    try:
        model = json.load(open(j)).get('analyzer', {}).get('model')
    except Exception:
        model = None
    if model != 'claude-fable-5-1':
        missing.append(n)
ranges, i = [], 0
while i < len(missing):
    j = i
    while j + 1 < len(missing) and missing[j + 1] == missing[j] + 1:
        j += 1
    ranges.append(str(missing[i]) if i == j else f'{missing[i]}-{missing[j]}')
    i = j + 1
print(','.join(ranges))
print(f'{len(missing)} of {len(pngs)} pages lack a Fable result', file=sys.stderr)
