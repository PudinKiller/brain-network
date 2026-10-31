#!/usr/bin/env python3
"""Assemble the CLI-captured demo frames. Run with the external media venv."""
from pathlib import Path
import os
import shutil
import subprocess
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[1]
FRAMES = ROOT.parent / '.bn-tools' / 'captures'
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
shutil.copyfile(Path(os.environ['WINDIR']) / 'Fonts' / 'segoeui.ttf', FRAMES / 'font.ttf')

captions = [
    'Your AI agents work inside your notes.',
    'Brain Network shows the whole picture.',
    'Who holds the ball: you, Claude or Codex.',
    'Agents hand work to agents, in the open.',
    'You judge only what needs you.',
    'Every handoff leaves a trail you can check.',
]
for i, text in enumerate(captions):
    (FRAMES / f'caption-{i}.txt').write_text(text, encoding='utf-8')
(FRAMES / 'end-title.txt').write_text('Brain Network', encoding='utf-8')
(FRAMES / 'end-tagline.txt').write_text('Agents do the legwork, you keep the judgment.', encoding='utf-8')
(FRAMES / 'end-link.txt').write_text('github.com/PudinKiller/brain-network', encoding='utf-8')

# Nominal boundaries follow the supplied seven-shot schedule. Extra frames overlap
# the following shot for a 0.35-second crossfade, keeping the final length at 60 s.
shots = [
    ('01-studio-map', 6, 0, True),
    ('01-studio-map', 3, 1, False),
    ('02-hierarchy', 5, 1, False),
    ('03-states', 10, 2, True),
    ('04-codex-brief', 3, 3, False),
    ('04b-brief-note', 3, 3, False),
    ('05-claude-result', 2, 3, False),
    ('05b-result-note', 4, 3, False),
    ('06-owner-card', 4, 4, False),
    ('07-owner-lightbox-a', 4, 4, False),
    ('08-owner-lightbox-b', 4, 4, False),
    ('09-done-trail', 7, 5, False),
    (None, 5, None, False),
]
assert sum(s[1] for s in shots) == 60
args = [FFMPEG, '-hide_banner', '-y', '-filter_complex_threads', '1']
for index, (name, seconds, _, _) in enumerate(shots):
    duration = seconds + (0.35 if index < len(shots) - 1 else 0)
    if name:
        args += ['-loop', '1', '-framerate', '30', '-t', str(duration), '-i', name + '.png']
    else:
        args += ['-f', 'lavfi', '-t', str(duration), '-i', 'color=c=0x090d19:s=1920x1080:r=30']

filters = []
for index, (name, seconds, caption, zoom) in enumerate(shots):
    common = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x090d19,setsar=1'
    if zoom:
        common += ",zoompan=z='1+0.015*on/300':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1920x1080:fps=30"
    if caption is not None:
        common += (f",drawbox=x=0:y=944:w=1920:h=136:color=0x090d19@0.96:t=fill"
                   f",drawtext=fontfile=font.ttf:textfile=caption-{caption}.txt:fontcolor=white:fontsize=39:x=64:y=974"
                   ",drawtext=fontfile=font.ttf:text='FICTIONAL DEMO  |  DISPATCH OFF':fontcolor=0xa8b0c8:fontsize=20:x=64:y=1034")
    else:
        common += (",drawbox=x=70:y=280:w=6:h=410:color=0x86dbc6:t=fill"
                   ",drawtext=fontfile=font.ttf:textfile=end-title.txt:fontcolor=white:fontsize=94:x=120:y=300"
                   ",drawtext=fontfile=font.ttf:textfile=end-tagline.txt:fontcolor=white:fontsize=49:x=120:y=450"
                   ",drawtext=fontfile=font.ttf:textfile=end-link.txt:fontcolor=0x86dbc6:fontsize=36:x=120:y=590"
                   ",drawtext=fontfile=font.ttf:text='Obsidian plugin  /  MIT License':fontcolor=0xa8b0c8:fontsize=26:x=120:y=720")
    filters.append(f'[{index}:v]{common},format=yuv420p,setpts=PTS-STARTPTS,fps=30,settb=AVTB[s{index}]')

previous = 's0'
offset = 0
for index in range(1, len(shots)):
    offset += shots[index - 1][1]
    current = f'fade{index}'
    filters.append(f'[{previous}][s{index}]xfade=transition=fade:duration=0.35:offset={offset},fps=30,settb=AVTB[{current}]')
    previous = current

output = ROOT / 'docs' / 'brain-network-60s.mp4'
args += ['-filter_complex', ';'.join(filters), '-map', f'[{previous}]', '-an', '-t', '60',
         '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
         '-movflags', '+faststart', '-map_metadata', '-1', str(output)]
with (FRAMES / 'render.log').open('w', encoding='utf-8') as log:
    subprocess.run(args, cwd=FRAMES, stdout=log, stderr=subprocess.STDOUT, check=True)
print(f'Rendered {output.name}: 60 s, 1920 x 1080, H.264, 30 fps, no audio.')
