"""Generate native icon bundles from app/assets/app-icon.png.

The source PNG is the single visual master. This script only resizes it; it
does not redraw, recolor, crop, or otherwise reinterpret the supplied artwork.
"""

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "app" / "assets" / "app-icon.png"
NATIVE = ROOT / "app" / "native"
WINDOWS = ROOT / "app" / "windows"


source = Image.open(SOURCE).convert("RGBA")
if source.width != source.height:
    raise RuntimeError(f"Application icon must be square, got {source.size!r}")

master = source.resize((1024, 1024), Image.Resampling.LANCZOS)
master.save(NATIVE / "AppIcon.icns", format="ICNS")
master.save(
    WINDOWS / "app-icon.ico",
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)

print(NATIVE / "AppIcon.icns")
print(WINDOWS / "app-icon.ico")
