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
    if (!data) return null;
    const digest = await crypto.subtle.digest("SHA-1", Utils._encoder.encode(data));
    return bufToHex(new Uint8Array(digest));
  }

  /** SHA-1 of raw binary data */
  async getSHABinary(data: ArrayBuffer | null | undefined): Promise<string | null> {
    if (!data) return null;
    const digest = await crypto.subtle.digest("SHA-1", data);
    return bufToHex(new Uint8Array(digest));
  }

  /** Returns a debounced version of `func` with the given delay (ms) */
  debounce<T extends (...args: unknown[]) => void>(func: T, delay: number): T {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return ((...args: unknown[]) => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), delay);
    }) as T;
  }
}

export default new Utils();
