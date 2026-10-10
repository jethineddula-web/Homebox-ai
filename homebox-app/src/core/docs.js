// Reading documents that aren't plain text: PDF and Word (.docx). Used for CVs, job posts, briefs.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');

const MAX_DOC_BYTES = 30 * 1024 * 1024;
const MAX_PAGES = 200;
const MAX_TEXT = 200_000;

// One file out of a zip (a .docx is a zip of XML files).
function unzipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This is not a valid .docx file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + nlen) === name) {
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 });
      throw new Error('This .docx file uses an unsupported compression.');
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()]);
const tidy = s => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

function docxText(buf) {
  const xml = unzipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('This .docx file has no document text.');
  const s = xml.toString('utf8')
    .replace(/<w:tab\/>/g, '\t').replace(/<w:(br|cr)\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, '\t').replace(/<\/w:tr>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return tidy(decode(s));
}

let pdfjs = null, pdfDir = '';
const slashDir = (...p) => path.join(...p).split(path.sep).join('/') + '/';  // pdf.js wants / and a trailing slash
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  // in the installed app this file is unpacked next to app.asar, so the ES module loader can read it
  const dir = path.dirname(require.resolve('pdfjs-dist/package.json')).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  pdfjs = await import(pathToFileURL(path.join(dir, 'legacy', 'build', 'pdf.min.mjs')).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(dir, 'legacy', 'build', 'pdf.worker.min.mjs')).href;
  pdfDir = dir;
  return pdfjs;
}

async function pdfText(buf) {
  const lib = await loadPdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, verbosity: 0,
    // character maps and fonts for PDFs in Chinese, Japanese, Korean and other scripts
    cMapUrl: slashDir(pdfDir, 'cmaps'), cMapPacked: true, standardFontDataUrl: slashDir(pdfDir, 'standard_fonts'),
  });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      pages.push(tc.items.map(it => (it.str || '') + (it.hasEOL ? '\n' : '')).join(''));
      page.cleanup();
    }
  } finally { await task.destroy(); }
  return { text: tidy(pages.map((t, i) => doc.numPages > 1 ? `--- page ${i + 1} ---\n${t}` : t).join('\n\n')), pages: doc.numPages };
}

async function readDocument(abs) {
  const ext = path.extname(abs).toLowerCase();
  const size = fs.statSync(abs).size;
  if (size > MAX_DOC_BYTES) throw new Error('This document is over 30 MB, too big to read.');
  const buf = await fs.promises.readFile(abs);
  let text, info;
  if (ext === '.pdf') {
    const r = await pdfText(buf);
    text = r.text; info = `PDF, ${r.pages} page${r.pages === 1 ? '' : 's'}`;
    if (!text.replace(/--- page \d+ ---/g, '').trim()) {
      return `${path.basename(abs)} (${info}) has no text inside. It is probably a scanned picture. Ask the user for a Word or text version, or to attach a picture of it to the chat.`;
    }
  } else if (ext === '.docx') {
    text = docxText(buf); info = 'Word document';
  } else {
    throw new Error('read_document reads .pdf and .docx files. Use read_file for text files.');
  }
  const cut = text.length > MAX_TEXT;
  return `${path.basename(abs)} (${info})\n\n${cut ? text.slice(0, MAX_TEXT) + '\n…[cut, the document is longer]' : text}`;
}

module.exports = { readDocument, docxText, unzipEntry };
