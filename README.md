# Snap Text Extractor

> [!NOTE]
> This is a personal-use fork by [ArnavK-09](https://github.com/ArnavK-09) of the original [snaptext](https://github.com/cwittenberg/snaptext) extension. All credit goes to the original authors.

GNOME Extension enabling the user to select an area of the screen to instantly extract and copy text to the clipboard using native Optical Character Recognition (OCR). Similar to how it works on MacOS.

## Features

- **Instant Text Extraction:** Select any part of your screen, and the text within that area is instantly processed and copied to your clipboard.
- **Multi-Pass OCR Routing:** Dynamically adjusts Page Segmentation Modes (PSM) based on aspect ratio, executing primary and fallback OCR passes to determine the most accurate text based on confidence and garbage ratios.
- **QR Code Detection:** Instantly detects and decodes QR codes using `zbar`, with an optional setting to automatically open HTTP/HTTPS links.
- **Extraction History:** Access a history of your 15 most recent text extractions from the GNOME Shell top panel menu.
- **Customizable Shortcut:** Set your own keyboard shortcut. The default is `Super + Shift + T`.
- **Visual Notifications:** Get system banner notifications when text is extracted or when you copy a previous extraction from your history.
- **Seamless GNOME Integration:** Built exclusively for GNOME Shell versions 45 through 50 using modern standard APIs.

## System Dependencies

This extension relies on standard native system tools to capture the screen, decode QR codes, preprocess images, and perform OCR extraction.

Before using the extension, install the required packages for your distribution.

### Ubuntu / Debian / Pop!_OS

```bash
sudo apt update
sudo apt install tesseract-ocr tesseract-ocr-eng zbar-tools imagemagick

```

### Fedora

```bash
sudo dnf install tesseract tesseract-langpack-eng zbar ImageMagick

```

### Arch Linux / Manjaro / CatchyOS

```bash
sudo pacman -S tesseract tesseract-data-eng zbar imagemagick

```

### Additional OCR Languages

Install the Tesseract language pack for any script you want to recognize, then restart GNOME Shell:

```bash
# Hindi
sudo pacman -S tesseract-data-hin

# Simplified Chinese
sudo pacman -S tesseract-data-chi_sim

# Japanese
sudo pacman -S tesseract-data-jpn
```

The extension automatically uses every installed language pack.

## Installation

### Method 1: Local Build

1. Clone the repository or download the source files.
2. Run the provided build script:

```bash
   ./build.sh

```

3. Restart GNOME Shell:

- **Wayland:** Log out and log back in.
- **X11:** Press `Alt + F2`, type `r`, and press `Enter`.

4. Enable the extension using the GNOME Extensions app or run:

```bash
   gnome-extensions enable snaptext@ArnavK-09
```

## License

This project is licensed under the GNU General Public License v3.0 (GPLv3). See the `LICENSE` file for full details.
