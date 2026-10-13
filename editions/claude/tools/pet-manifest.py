#!/usr/bin/env python3
"""Builds Resources/web/pet/clips/clips.json (the pet's clips.json contract,
version 1) from the per-clip metadata tools/build-clip.py --meta writes while
tools/build-pet.sh runs (build/pet/<name>.json by default) and the clips
tools/pet-clips.json lists (name, kind, source). Only a clip whose .mov and
meta file both exist is listed, so the pet runtime can ship with any subset
of idle/sit/feet/snap/click (the contract requires only idle); the top-level
size/fps/box are hoisted from idle's own meta if idle is present, else
whichever listed clip was built first.

usage: python tools/pet-manifest.py [--config tools/pet-clips.json]
           [--meta-dir build/pet] [--clips-dir Resources/web/pet/clips]
           [--out Resources/web/pet/clips/clips.json]
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default=str(ROOT / 'tools' / 'pet-clips.json'))
    parser.add_argument('--meta-dir', default=str(ROOT / 'build' / 'pet'))
    parser.add_argument('--clips-dir', default=str(ROOT / 'Resources' / 'web' / 'pet' / 'clips'))
    parser.add_argument('--out', default=str(ROOT / 'Resources' / 'web' / 'pet' / 'clips' / 'clips.json'))
    args = parser.parse_args()

    config = json.loads(Path(args.config).read_text())
    meta_dir, clips_dir = Path(args.meta_dir), Path(args.clips_dir)

    clips = {}
    metas = {}
    for entry in config['clips']:
        name = entry['name']
        meta_path, mov_path = meta_dir / f'{name}.json', clips_dir / f'{name}.mov'
        if not mov_path.exists() or not meta_path.exists():
            missing = 'clip' if not mov_path.exists() else 'meta'
            print(f'{name}: skipped (no {missing}, {mov_path if missing == "clip" else meta_path} not found)')
            continue
        meta = json.loads(meta_path.read_text())
        metas[name] = meta
        clips[name] = {
            'file': f'{name}.mov',
            'kind': entry['kind'],
            'frames': meta['frames'],
            'seconds': meta['seconds'],
            'from': meta['from'],
            'to': meta['to'],
            'safe': meta['safe'],
            'mask': meta['mask'],
        }

    if not clips:
        raise SystemExit('no pet clip has both a built .mov and a --meta file; nothing to write')
    hoisted = metas.get('idle') or next(iter(metas.values()))
    manifest = {
        'version': 1,
        'size': hoisted['size'],
        'fps': hoisted['fps'],
        'box': hoisted['box'],
        'clips': clips,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'wrote {out_path}: {", ".join(clips)} ({len(clips)} of {len(config["clips"])} clip(s)), '
          f'size {manifest["size"]}, {manifest["fps"]} fps')


if __name__ == '__main__':
    main()
