/**
 * Shared utilities: SHA-256 hashing, binary file detection, debounce.
 * Uses the browser Web Crypto API (available in Obsidian / Electron).
 */

// ---------- Hex table for fast buffer-to-hex ----------
const HEX_TABLE: string[] = [];
for (let i = 0; i < 256; i++) HEX_TABLE.push(i.toString(16).padStart(2, "0"));

function bufToHex(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i++) s += HEX_TABLE[buf[i]!]!;
  return s;
}

// ---------- Chunked byte->binary-string (for base64) ----------
// String.fromCharCode.apply over subarrays instead of a per-byte `+=` loop.
// The per-byte loop builds a rope one character at a time — O(n) with a huge
// constant and 3–4× transient memory on large files (measured ~10× slower at
// 5 MB). Chunk size stays under the JS engine's argument-count ceiling.
const B64_CHUNK = 0x8000; // 32 KiB
function bytesToBinaryString(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i += B64_CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      data.subarray(i, i + B64_CHUNK) as unknown as number[]
    );
  }
  return binary;
}

// ---------- Binary extension set ----------
const BINARY_EXTS = new Set([
  "3dm","3ds","3g2","3gp","7z","a","aac","adp","afdesign","afphoto","afpub","ai","aif","aiff",
  "alz","ape","apk","appimage","ar","arj","asf","au","avi","bak","baml","bh","bin","bk","bmp",
  "btif","bz2","bzip2","cab","caf","cgm","class","cmx","cpio","cr2","cur","dat","dcm","deb",
  "dex","djvu","dll","dmg","dng","doc","docm","docx","dot","dotm","dra","DS_Store","dsk","dts",
  "dtshd","dvb","dwg","dxf","egg","eot","epub","exe","f4v","fbs","fh","fla","flac","flatpak",
  "fli","flv","fpx","fst","fvt","g3","gh","gif","graffle","gz","gzip","h261","h263","h264",
  "icns","ico","ief","img","ipa","iso","jar","jpeg","jpg","jpgv","jpm","jxr","key","ktx","lha",
  "lib","lvp","lz","lzh","lzma","lzo","m3u","m4a","m4v","mar","mdi","mht","mid","midi","mj2",
  "mka","mkv","mmr","mng","mobi","mov","movie","mp3","mp4","mp4a","mpeg","mpg","mpga","mxu",
  "nef","npx","numbers","nupkg","o","odp","ods","odt","oga","ogg","ogv","otf","ott","pages",
  "pbm","pcx","pdb","pdf","pea","pgm","pic","png","pnm","pot","potm","potx","ppa","ppam","ppm",
  "pps","ppsm","ppsx","ppt","pptm","pptx","psd","pya","pyc","pyo","pyv","qt","rar","ras","raw",
  "resources","rgb","rip","rlc","rmf","rmvb","rpm","rtf","rz","s3m","s7z","scpt","sgi","shar",
  "snap","sil","sketch","slk","smv","snk","so","stl","suo","sub","swf","tar","tbz","tbz2","tga",
  "tgz","thmx","tif","tiff","tlz","ttc","ttf","txz","udf","uvh","uvi","uvm","uvp","uvs","uvu",
  "viv","vob","war","wav","wax","wbmp","wdp","weba","webm","webp","whl","wim","wm","wma","wmv",
  "wmx","woff","woff2","wrm","wvx","xbm","xif","xla","xlam","xls","xlsb","xlsm","xlsx","xlt",
  "xltm","xltx","xm","xmind","xpi","xpm","xwd","xz","z","zip","zipx",
]);

class Utils {
  private static readonly _encoder = new TextEncoder();

  /** True if the file extension is a known binary type */
  isBinary(path: string): boolean {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return BINARY_EXTS.has(ext);
  }

  /** SHA-1 of a UTF-8 string (returns hex string, or null for empty input) */
  async getSHA(data: string | null | undefined): Promise<string | null> {
    // Only null/undefined mean "no content". An EMPTY string is real content and
    // must hash to the well-defined SHA-1 of "" — returning null here gave empty
    // files a blank sha1, which defeats the upload-dedupe (both skip checks want a
    // truthy sha), so empty config files (e.g. an empty plugin data.json) re-sent
    // on every 5s config poll forever, bloating version history.
    if (data == null) return null;
    const digest = await crypto.subtle.digest("SHA-1", Utils._encoder.encode(data));
    return bufToHex(new Uint8Array(digest));
  }

  /** SHA-1 of raw binary data */
  async getSHABinary(data: ArrayBuffer | null | undefined): Promise<string | null> {
    if (!data) return null;
    const digest = await crypto.subtle.digest("SHA-1", data);
    return bufToHex(new Uint8Array(digest));
  }

  /** Converts a Uint8Array or string to a base64 string */
  toBase64(data: Uint8Array | string): string {
    if (typeof data === "string") {
      return btoa(unescape(encodeURIComponent(data)));
    }
    return btoa(bytesToBinaryString(data));
  }

  /** Converts a base64 string to a Uint8Array */
  fromBase64(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** Extract a human-readable message from an unknown thrown value. */
  errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === "string") return e;
    return e == null ? "" : String(e);
  }

  /** Normalise an unknown thrown value into an Error for safe re-throwing. */
  toError(e: unknown): Error {
    return e instanceof Error ? e : new Error(this.errorMessage(e));
  }

  /** Returns a debounced version of fn that fires after delay ms of silence. */
  debounce<T extends unknown[]>(fn: (...args: T) => void, delay: number): (...args: T) => void {
    let timer: number | null = null;
    return (...args: T) => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; fn(...args); }, delay);
    };
  }

}

export default new Utils();
