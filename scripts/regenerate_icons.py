from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "branding" / "trinity-logo-square.png"
CANONICAL_SOURCE = ROOT / "assets" / "branding" / "trinity-logo-source.png"
TAURI_ICONS = ROOT / "src-tauri" / "icons"
EXTENSION_ICONS = ROOT / "browser-extension" / "chrome" / "icons"


def ensure_rgba(image: Image.Image) -> Image.Image:
    return image.convert("RGBA")


def resize(image: Image.Image, size: int) -> Image.Image:
    return image.resize((size, size), Image.Resampling.LANCZOS)


def save_png(image: Image.Image, path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    resize(image, size).save(path, format="PNG")


def save_ico(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(
        path,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


def save_icns(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="ICNS")


def main() -> None:
    source_image = ensure_rgba(Image.open(SOURCE))
    CANONICAL_SOURCE.parent.mkdir(parents=True, exist_ok=True)
    source_image.save(CANONICAL_SOURCE, format="PNG")

    tauri_pngs = {
        "32x32.png": 32,
        "64x64.png": 64,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
        "Square30x30Logo.png": 30,
        "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107,
        "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310,
        "StoreLogo.png": 50,
    }

    for filename, size in tauri_pngs.items():
        save_png(source_image, TAURI_ICONS / filename, size)

    save_ico(source_image, TAURI_ICONS / "icon.ico")
    save_icns(source_image, TAURI_ICONS / "icon.icns")

    extension_pngs = {
        "icon16.png": 16,
        "icon32.png": 32,
        "icon48.png": 48,
        "icon128.png": 128,
    }

    for filename, size in extension_pngs.items():
        save_png(source_image, EXTENSION_ICONS / filename, size)

    ios_pngs = {
        "AppIcon-20x20@1x.png": 20,
        "AppIcon-20x20@2x.png": 40,
        "AppIcon-20x20@2x-1.png": 40,
        "AppIcon-20x20@3x.png": 60,
        "AppIcon-29x29@1x.png": 29,
        "AppIcon-29x29@2x.png": 58,
        "AppIcon-29x29@2x-1.png": 58,
        "AppIcon-29x29@3x.png": 87,
        "AppIcon-40x40@1x.png": 40,
        "AppIcon-40x40@2x.png": 80,
        "AppIcon-40x40@2x-1.png": 80,
        "AppIcon-40x40@3x.png": 120,
        "AppIcon-60x60@2x.png": 120,
        "AppIcon-60x60@3x.png": 180,
        "AppIcon-76x76@1x.png": 76,
        "AppIcon-76x76@2x.png": 152,
        "AppIcon-83.5x83.5@2x.png": 167,
        "AppIcon-512@2x.png": 1024,
    }

    for filename, size in ios_pngs.items():
        save_png(source_image, TAURI_ICONS / "ios" / filename, size)

    android_pngs = {
        "mipmap-mdpi/ic_launcher.png": 48,
        "mipmap-mdpi/ic_launcher_round.png": 48,
        "mipmap-mdpi/ic_launcher_foreground.png": 108,
        "mipmap-hdpi/ic_launcher.png": 72,
        "mipmap-hdpi/ic_launcher_round.png": 72,
        "mipmap-hdpi/ic_launcher_foreground.png": 162,
        "mipmap-xhdpi/ic_launcher.png": 96,
        "mipmap-xhdpi/ic_launcher_round.png": 96,
        "mipmap-xhdpi/ic_launcher_foreground.png": 216,
        "mipmap-xxhdpi/ic_launcher.png": 144,
        "mipmap-xxhdpi/ic_launcher_round.png": 144,
        "mipmap-xxhdpi/ic_launcher_foreground.png": 324,
        "mipmap-xxxhdpi/ic_launcher.png": 192,
        "mipmap-xxxhdpi/ic_launcher_round.png": 192,
        "mipmap-xxxhdpi/ic_launcher_foreground.png": 432,
    }

    for relative_path, size in android_pngs.items():
        save_png(source_image, TAURI_ICONS / "android" / relative_path, size)


if __name__ == "__main__":
    main()
