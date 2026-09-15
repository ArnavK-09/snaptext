// ocr.js
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GdkPixbuf from "gi://GdkPixbuf";

const LOCALE_TO_TESS = {
  en: "eng",
  fr: "fra",
  de: "deu",
  es: "spa",
  it: "ita",
  pt: "por",
  nl: "nld",
  ru: "rus",
  ar: "ara",
  ja: "jpn",
  ko: "kor",
  hi: "hin",
  tr: "tur",
  pl: "pol",
  uk: "ukr",
  vi: "vie",
  ro: "ron",
  el: "ell",
  he: "heb",
  zh: "chi_sim",
  cs: "ces",
  da: "dan",
  fi: "fin",
  no: "nor",
  nb: "nor",
  sv: "swe",
  hu: "hun",
  id: "ind",
  ms: "msa",
  th: "tha",
  sk: "slk",
  sl: "slv",
  bg: "bul",
  hr: "hrv",
  lt: "lit",
  lv: "lav",
  et: "est",
  sr: "srp",
  fa: "fas",
  bn: "ben",
  ta: "tam",
  te: "tel",
  ml: "mal",
  kn: "kan",
  mr: "mar",
  gu: "guj",
  sw: "swa",
  ca: "cat",
  bs: "bos",
  ur: "urd",
  eu: "eus",
  gl: "glg",
  cy: "cym",
  ga: "gle",
  is: "isl",
  mk: "mkd",
  sq: "sqi",
  be: "bel",
  az: "aze",
  hy: "hye",
  ka: "kat",
  af: "afr",
};

let _langsCache = null;

function _upscaleFactor(width, height) {
  if (width <= 0 || height <= 0) return 0;
  let min = Math.min(width, height);
  if (min < 200) return 3;
  if (min < 600) return 2;
  return 0;
}

function _readBrightness(path, cancellable) {
  return new Promise((resolve) => {
    try {
      GdkPixbuf.Pixbuf.new_from_file_at_scale_async(
        path,
        64,
        64,
        true,
        cancellable,
        (_src, res) => {
          try {
            let pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale_finish(res);
            if (!pixbuf) {
              resolve(0.5);
              return;
            }

            let width = pixbuf.get_width();
            let height = pixbuf.get_height();
            let channels = pixbuf.get_n_channels();
            let stride = pixbuf.get_rowstride();
            let pixels = pixbuf.get_pixels();
            let sum = 0;
            let count = 0;

            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                let off = y * stride + x * channels;
                let r = pixels[off];
                let g = channels > 1 ? pixels[off + 1] : r;
                let b = channels > 2 ? pixels[off + 2] : r;
                sum += 0.299 * r + 0.587 * g + 0.114 * b;
                count++;
              }
            }

            resolve(count ? sum / count / 255 : 0.5);
          } catch (e) {
            resolve(0.5);
          }
        },
      );
    } catch (e) {
      resolve(0.5);
    }
  });
}

export class OcrProcessor {
  constructor(cancellable, activeProcesses, logDebugFn, onProgressFn) {
    this._cancellable = cancellable;
    this._activeProcesses = activeProcesses;
    this._logDebug = logDebugFn || function () {};
    this._onProgress = onProgressFn || function () {};
  }

  _isCancelled() {
    return !this._cancellable || this._cancellable.is_cancelled();
  }

  async _wait(process) {
    return new Promise((resolve) => {
      process.wait_async(this._cancellable, (proc, result) => {
        try {
          proc.wait_finish(result);
          resolve(proc.get_successful());
        } catch (e) {
          resolve(false);
        }
      });
    });
  }

  async _readStdout(process) {
    return new Promise((resolve) => {
      process.communicate_utf8_async(
        null,
        this._cancellable,
        (proc, result) => {
          try {
            let [, stdout] = proc.communicate_utf8_finish(result);
            resolve(stdout);
          } catch (e) {
            resolve("");
          }
        },
      );
    });
  }

  async _readQrCode(imagePath) {
    if (!GLib.find_program_in_path("zbarimg")) {
      return null;
    }

    try {
      let zbar = Gio.Subprocess.new(
        ["zbarimg", "--quiet", "--raw", imagePath],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
      );
      this._activeProcesses.add(zbar);
      let stdout = await this._readStdout(zbar);
      this._activeProcesses.delete(zbar);

      if (stdout && stdout.trim().length > 0) {
        return stdout.trim();
      }
    } catch (error) {
      this._logDebug(`zbarimg QR code detection failed: ${error}`);
    }
    return null;
  }

  async _listTesseractLanguages() {
    let proc = Gio.Subprocess.new(
      ["tesseract", "--list-langs"],
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    );
    this._activeProcesses.add(proc);
    let stdout = await this._readStdout(proc);
    this._activeProcesses.delete(proc);

    if (!stdout) return [];

    let langs = [];
    for (let line of stdout.split("\n")) {
      let lang = line.trim();
      if (
        lang &&
        lang !== "osd" &&
        /^[a-zA-Z]{2,3}(_[a-zA-Z]{2,4})?$/.test(lang)
      ) {
        langs.push(lang);
      }
    }
    return langs;
  }

  async _loadTesseractLanguages() {
    let fallback = "eng";
    if (!GLib.find_program_in_path("tesseract")) {
      return fallback;
    }

    try {
      let available = await this._listTesseractLanguages();
      if (available.length === 0) {
        return fallback;
      }

      let desired = [];
      for (let name of GLib.get_language_names()) {
        let code = String(name)
          .split(/[._@-]/)[0]
          .toLowerCase();
        if (!code) continue;
        let mapped = LOCALE_TO_TESS[code];
        if (mapped) {
          desired.push(mapped);
        } else if (code.length === 2) {
          let matches = available.filter((l) => l.startsWith(code));
          if (matches.length > 0) desired.push(matches[0]);
        }
      }
      desired.push("eng");

      // Use every installed language pack so non-locale scripts (e.g. Hindi
      // on an English desktop) are also available for OCR.
      for (let lang of available) {
        if (lang !== "osd") {
          desired.push(lang);
        }
      }

      let result = [];
      let seen = new Set();
      for (let lang of desired) {
        if (!seen.has(lang) && available.includes(lang)) {
          seen.add(lang);
          result.push(lang);
        }
      }

      return result.length > 0 ? result.join("+") : fallback;
    } catch (error) {
      return fallback;
    }
  }

  async _availableTesseractLanguages() {
    if (_langsCache) {
      return _langsCache;
    }
    _langsCache = await this._loadTesseractLanguages();
    return _langsCache;
  }

  async _preprocess(imagePath) {
    let width = 0;
    let height = 0;
    let brightness = 0.5;

    let [format, w, h] = GdkPixbuf.Pixbuf.get_file_info(imagePath);
    if (format) {
      width = w;
      height = h;
    }

    brightness = await _readBrightness(imagePath, this._cancellable);

    if (GLib.find_program_in_path("mogrify")) {
      let factor = _upscaleFactor(width, height);
      let args = [
        "mogrify",
        "-colorspace",
        "Gray",
        "-contrast-stretch",
        "2%x2%",
      ];
      if (factor > 0) {
        args.push("-resize", `${factor * 100}%`);
      }
      args.push("-sharpen", "0x1");
      if (brightness < 0.45) {
        args.push("-negate");
      }
      args.push(imagePath);

      let mogrify = Gio.Subprocess.new(args, Gio.SubprocessFlags.NONE);
      this._activeProcesses.add(mogrify);
      await this._wait(mogrify);
      this._activeProcesses.delete(mogrify);
    }

    return { width, height, brightness };
  }

  async _negate(path) {
    if (!GLib.find_program_in_path("mogrify")) {
      return;
    }
    let proc = Gio.Subprocess.new(
      ["mogrify", "-negate", path],
      Gio.SubprocessFlags.NONE,
    );
    this._activeProcesses.add(proc);
    await this._wait(proc);
    this._activeProcesses.delete(proc);
  }

  async _copyFile(src, dest) {
    let source = Gio.File.new_for_path(src);
    let target = Gio.File.new_for_path(dest);
    if (!source.query_exists(null)) {
      return false;
    }

    try {
      await new Promise((resolve, reject) => {
        source.copy_async(
          target,
          Gio.FileCopyFlags.OVERWRITE,
          GLib.PRIORITY_DEFAULT,
          this._cancellable,
          null,
          (s, res) => {
            try {
              s.copy_finish(res);
              resolve();
            } catch (e) {
              reject(e);
            }
          },
        );
      });
      return true;
    } catch (e) {
      this._logDebug(`File copy failed: ${e}`);
      return false;
    }
  }

  _deleteFile(path) {
    let f = Gio.File.new_for_path(path);
    if (f.query_exists(null)) {
      f.delete_async(GLib.PRIORITY_DEFAULT, null, null);
    }
  }

  async _runTesseract(imagePath, psm, langs) {
    if (!GLib.find_program_in_path("tesseract")) {
      return null;
    }

    let proc = Gio.Subprocess.new(
      [
        "tesseract",
        imagePath,
        "stdout",
        "-l",
        langs,
        "--psm",
        String(psm),
        "tsv",
      ],
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    );

    this._activeProcesses.add(proc);
    let stdout = await this._readStdout(proc);
    this._activeProcesses.delete(proc);

    if (this._isCancelled() || stdout == null) {
      return null;
    }

    let rows = [];
    let lines = stdout.split("\n");

    for (let i = 1; i < lines.length; i++) {
      let cols = lines[i].split("\t");
      if (cols.length < 12) continue;

      let level = parseInt(cols[0], 10);
      if (level !== 5) continue;

      let conf = parseFloat(cols[10]);
      if (conf < 0) continue;

      let text = cols[11];
      if (!text || !text.trim()) continue;

      rows.push({
        block: parseInt(cols[2], 10),
        par: parseInt(cols[3], 10),
        line: parseInt(cols[4], 10),
        word: parseInt(cols[5], 10),
        left: parseInt(cols[6], 10),
        top: parseInt(cols[7], 10),
        width: parseInt(cols[8], 10),
        height: parseInt(cols[9], 10),
        conf,
        text,
      });
    }

    if (rows.length === 0) {
      return {
        text: "",
        confidence: 0,
        wordCount: 0,
        charCount: 0,
        garbageRatio: 0,
      };
    }

    let text = "";
    let prevKey = null;
    for (let w of rows) {
      let key = `${w.block}\u0000${w.par}\u0000${w.line}`;
      if (prevKey !== null) {
        text += key === prevKey ? " " : "\n";
      }
      text += w.text;
      prevKey = key;
    }

    let totalConf = 0;
    for (let w of rows) {
      totalConf += w.conf;
    }

    let confidence = totalConf / rows.length;
    let charCount = text.length;
    let garbage = (
      text.match(/[^a-zA-Z0-9\s.,!?@:/'\-"()[\]{}_+=$%&*;]/g) || []
    ).length;
    let garbageRatio = charCount > 0 ? garbage / charCount : 0;

    this._logDebug(
      `PSM ${psm}: conf=${confidence.toFixed(1)} words=${rows.length} chars=${charCount} garbage=${garbageRatio.toFixed(2)}`,
    );

    return {
      text,
      confidence,
      wordCount: rows.length,
      charCount,
      garbageRatio,
    };
  }

  _routePsm(width, height) {
    if (width > 0 && height > 0) {
      let aspect = width / height;
      if (height <= 90 && aspect >= 4)
        return { primaryPsm: 7, fallbackPsm: 13 };
      if (width <= 220 && height <= 100)
        return { primaryPsm: 8, fallbackPsm: 7 };
      if (width >= 900 && height >= 900)
        return { primaryPsm: 3, fallbackPsm: 6 };
    }
    return { primaryPsm: 6, fallbackPsm: 11 };
  }

  _acceptable(res) {
    return (
      res &&
      res.wordCount > 0 &&
      res.charCount >= 2 &&
      res.confidence >= 55 &&
      res.garbageRatio < 0.35
    );
  }

  _score(res) {
    if (!res) return -9999;
    return (
      res.confidence +
      Math.min(res.wordCount, 20) * 0.5 +
      Math.min(res.charCount, 160) * 0.03 -
      res.garbageRatio * 25
    );
  }

  _cleanupText(text) {
    return text.replace(/\n{3,}/g, "\n\n").trim();
  }

  async _ocrMultiPass(imagePath, langs, width, height, brightness) {
    let { primaryPsm, fallbackPsm } = this._routePsm(width, height);

    this._onProgress("Reading text…");
    let res1 = await this._runTesseract(imagePath, primaryPsm, langs);
    if (this._isCancelled()) return null;

    if (res1 && this._acceptable(res1)) {
      return { text: this._cleanupText(res1.text), isQr: false };
    }

    this._onProgress("Trying alternative mode…");
    let res2 = await this._runTesseract(imagePath, fallbackPsm, langs);
    if (this._isCancelled()) return null;

    let res3 = null;
    if (brightness >= 0.45) {
      this._onProgress("Trying inverted image…");
      let negated = imagePath.replace(/\.png$/, "-negated.png");
      if (await this._copyFile(imagePath, negated)) {
        await this._negate(negated);
        if (!this._isCancelled()) {
          res3 = await this._runTesseract(negated, primaryPsm, langs);
        }
        this._deleteFile(negated);
      }
    }
    if (this._isCancelled()) return null;

    let candidates = [res1, res2, res3].filter(Boolean);
    if (candidates.length === 0) {
      return { text: "", isQr: false };
    }

    let best = candidates.reduce((a, b) =>
      this._score(a) >= this._score(b) ? a : b,
    );
    if (!best.text || !best.text.trim()) {
      return { text: "", isQr: false };
    }

    return { text: this._cleanupText(best.text), isQr: false };
  }

  async processImage(imagePath, skipQr = false) {
    this._logDebug(`Processing image: ${imagePath}`);

    if (!skipQr) {
      this._onProgress("Checking for QR code…");
      let qrText = await this._readQrCode(imagePath);
      if (qrText && !this._isCancelled()) {
        this._logDebug("QR code detected, bypassing OCR.");
        return { text: qrText, isQr: true };
      }
    }

    let langs = await this._availableTesseractLanguages();
    if (this._isCancelled()) return null;

    this._onProgress("Enhancing image…");
    let dims = await this._preprocess(imagePath);
    if (this._isCancelled()) return null;

    return this._ocrMultiPass(
      imagePath,
      langs,
      dims.width,
      dims.height,
      dims.brightness,
    );
  }
}
