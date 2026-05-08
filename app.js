/**
 * 在线文档 / 图片 / 四六级证件照 — 纯前端逻辑
 * 依赖：index.html 中的全局库；MediaPipe 仅在「证件照」功能中按需动态加载，避免 CDN 失败导致整页脚本不执行。
 */

const MEDIAPIPE_ESM =
  'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/selfie_segmentation.js';
const MEDIAPIPE_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/';

let selfieSegmentationClassPromise = null;

function loadSelfieSegmentationClass() {
  if (!selfieSegmentationClassPromise) {
    selfieSegmentationClassPromise = import(MEDIAPIPE_ESM).then(
      (m) => m.SelfieSegmentation
    );
  }
  return selfieSegmentationClassPromise;
}

// 四六级常用蓝底（近似报名系统常见色）
const CET_BLUE = '#438edb';
const CET_WHITE = '#ffffff';

/* ---------- 工具 ---------- */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function baseName(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(0, i) : name;
}

function setProgress(el, show, pct, text) {
  if (!el) return;
  el.hidden = !show;
  const bar = el.querySelector('.progress-bar');
  const label = el.querySelector('.progress-text');
  if (bar && !bar.classList.contains('indeterminate')) {
    bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  }
  if (label && text != null) label.textContent = text;
}

function showError(el, msg) {
  if (!el) return;
  if (msg) {
    el.hidden = false;
    el.textContent = msg;
  } else {
    el.hidden = true;
    el.textContent = '';
  }
}

/** RTF 简易转纯文本（复杂排版可能不完整） */
function rtfToPlain(rtf) {
  let t = rtf.replace(/\r\n/g, '\n');
  t = t.replace(/\{\\\*[^}]*\}/g, '');
  t = t.replace(/\\'([0-9a-f]{2})/gi, (_, h) =>
    String.fromCharCode(parseInt(h, 16))
  );
  t = t.replace(/\\u(-?\d+)\??/gi, (_, n) =>
    String.fromCharCode(parseInt(n, 10))
  );
  t = t.replace(/\\[a-z]+\d* ?/gi, '');
  t = t.replace(/[{}]/g, '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/* ---------- 导航 ---------- */

function initNav() {
  const tabs = document.querySelectorAll('.nav-tab');
  const panels = {
    doc: document.getElementById('panel-doc'),
    image: document.getElementById('panel-image'),
    photo: document.getElementById('panel-photo'),
  };

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const id = tab.dataset.panel;
      tabs.forEach((t) => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });
      Object.entries(panels).forEach(([key, panel]) => {
        if (!panel) return;
        const on = key === id;
        panel.classList.toggle('active', on);
        panel.hidden = !on;
      });
    });
  });
}

/* ---------- PDF.js ---------- */

function ensurePdfWorker() {
  if (window.pdfjsLib && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
}

/**
 * 将 PDF.js getTextContent 的 items 按坐标还原为多行文本（避免原先 join 成一行丢换行）
 */
function pdfTextContentToString(content) {
  const items = (content.items || []).filter(
    (it) => it && typeof it.str === 'string' && it.str.length
  );
  if (!items.length) return '';

  const enriched = items.map((it) => {
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    return {
      str: it.str,
      x: tr[4],
      y: tr[5],
      w: typeof it.width === 'number' && it.width > 0 ? it.width : 0,
      h: typeof it.height === 'number' && it.height > 0 ? it.height : 12,
      hasEOL: !!it.hasEOL,
    };
  });

  const avgH =
    enriched.reduce((s, i) => s + i.h, 0) / enriched.length || 12;
  const lineTol = Math.max(avgH * 0.42, 2.5);

  enriched.sort((a, b) => {
    const dy = b.y - a.y;
    if (Math.abs(dy) > lineTol * 0.35) return dy > 0 ? 1 : -1;
    return a.x - b.x;
  });

  const lines = [];
  let cur = [];
  let curY = null;

  for (const it of enriched) {
    if (curY === null || Math.abs(it.y - curY) <= lineTol) {
      cur.push(it);
      if (curY === null) curY = it.y;
    } else {
      lines.push(cur);
      cur = [it];
      curY = it.y;
    }
  }
  if (cur.length) lines.push(cur);

  const lineStrs = lines.map((line) => {
    line.sort((a, b) => a.x - b.x);
    let s = '';
    let prevRight = null;
    for (const it of line) {
      if (prevRight !== null) {
        const gap = it.x - prevRight;
        if (gap > avgH * 0.12) s += gap > avgH * 0.45 ? '  ' : ' ';
      }
      s += it.str;
      const estW =
        it.w > 0 ? it.w : Math.max(it.str.length * avgH * 0.35, avgH * 0.4);
      prevRight = it.x + estW;
      if (it.hasEOL) s += '\n';
    }
    return s.replace(/[ \t]+$/g, '');
  });

  return lineStrs.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

/* ---------- 文档：解析为 HTML + 纯文本 ---------- */

async function parseDocument(file) {
  const ext = extOf(file.name);
  const buf = await file.arrayBuffer();

  if (ext === 'txt') {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return {
      html: `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(
        text
      )}</pre>`,
      text,
      ext,
    };
  }

  if (ext === 'md') {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return {
      html: `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(
        text
      )}</pre>`,
      text,
      ext,
      rawMarkdown: true,
    };
  }

  if (ext === 'docx') {
    if (!window.mammoth) throw new Error('文档库未加载，请检查网络');
    const mammothOpts = {
      arrayBuffer: buf,
      ignoreEmptyParagraphs: false,
    };
    const htmlResult = await window.mammoth.convertToHtml(mammothOpts);
    const textResult = await window.mammoth.extractRawText(mammothOpts);
    return { html: htmlResult.value, text: textResult.value, ext };
  }

  if (ext === 'doc') {
    throw new Error(
      '浏览器无法直接解析旧版 .doc。请用 Word / WPS 另存为 .docx 后重新上传。'
    );
  }

  if (ext === 'pdf') {
    ensurePdfWorker();
    if (!window.pdfjsLib) throw new Error('PDF 库未加载');
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let fullText = '';
    const n = pdf.numPages;
    for (let i = 1; i <= n; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent({ normalizeWhitespace: false });
      const pageText = pdfTextContentToString(content);
      fullText += pageText.trimEnd() + (i < n ? '\n\n' : '');
      if (typeof parseDocument.onProgress === 'function') {
        parseDocument.onProgress(Math.round((i / n) * 100));
      }
    }
    fullText = fullText.trim();
    return {
      html: `<pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.55;margin:0">${escapeHtml(
        fullText
      )}</pre>`,
      text: fullText,
      ext,
    };
  }

  if (ext === 'rtf') {
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    const text = rtfToPlain(raw);
    return {
      html: `<pre style="white-space:pre-wrap">${escapeHtml(text)}</pre>`,
      text,
      ext,
    };
  }

  throw new Error(`不支持的文档扩展名：.${ext}`);
}

function wrapHtmlDocument(innerBody) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${innerBody}</body></html>`;
}

/** html-docx 对 &lt;pre&gt; 支持差，换成带 pre-wrap 的 div 更易保留换行 */
function normalizeHtmlForDocx(html) {
  if (!html) return html;
  return html.replace(
    /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
    '<div style="white-space:pre-wrap;line-height:1.55;font-size:11pt;font-family:Calibri,\'Microsoft YaHei\',sans-serif">$1</div>'
  );
}

function exportRtf(text) {
  const esc = String(text)
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\n/g, '\\par\n');
  return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Microsoft YaHei;}}\\f0\\fs24 ${esc}}`;
}

/**
 * 用 jsPDF 按「真实换行」排多页正文（比整页截图更利于保留段落与换行）
 */
function containsCJK(s) {
  return /[\u3000-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff]/.test(
    s || ''
  );
}

function writePlainTextToPdf(pdf, plain, marginMm, maxWidthMm, lineHmm) {
  const pageH = pdf.internal.pageSize.getHeight();
  let y = marginMm;
  const rawLines = plain.replace(/\r\n/g, '\n').split('\n');

  for (const raw of rawLines) {
    if (raw === '') {
      y += lineHmm * 0.45;
      if (y > pageH - marginMm) {
        pdf.addPage();
        y = marginMm;
      }
      continue;
    }
    const wrapped = pdf.splitTextToSize(raw, maxWidthMm);
    for (const line of wrapped) {
      if (y > pageH - marginMm) {
        pdf.addPage();
        y = marginMm;
      }
      pdf.text(line, marginMm, y);
      y += lineHmm;
    }
  }
}

/** 长文排版：按 A4 高度切片 canvas，避免中文整页缩成一条或只出一页 */
function canvasToPagedPdfBlob(canvas) {
  const { jsPDF } = window.jspdf;
  if (!jsPDF) throw new Error('jsPDF 未加载');
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'p' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 18;
  const maxW = pageW - margin * 2;
  const maxH = pageH - margin * 2;
  const imgHeightMm = (canvas.height * maxW) / canvas.width;
  let offsetMm = 0;
  let first = true;

  while (offsetMm < imgHeightMm - 0.01) {
    if (!first) pdf.addPage();
    first = false;
    const sliceMm = Math.min(maxH, imgHeightMm - offsetMm);
    const srcY = (offsetMm / imgHeightMm) * canvas.height;
    const srcH = (sliceMm / imgHeightMm) * canvas.height;
    const sliceCanvas = document.createElement('canvas');
    sliceCanvas.width = canvas.width;
    sliceCanvas.height = Math.max(1, Math.ceil(srcH));
    const sctx = sliceCanvas.getContext('2d');
    sctx.fillStyle = '#ffffff';
    sctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
    sctx.drawImage(
      canvas,
      0,
      srcY,
      canvas.width,
      srcH,
      0,
      0,
      canvas.width,
      srcH
    );
    const imgData = sliceCanvas.toDataURL('image/jpeg', 0.9);
    pdf.addImage(imgData, 'JPEG', margin, margin, maxW, sliceMm);
    offsetMm += sliceMm;
  }

  return pdf.output('blob');
}

async function exportPdfFromHtml(html) {
  const { jsPDF } = window.jspdf;
  if (!jsPDF) throw new Error('jsPDF 未加载');

  const holder = document.createElement('div');
  holder.style.position = 'fixed';
  holder.style.left = '-9999px';
  holder.style.top = '0';
  holder.style.width = '190mm';
  holder.style.maxWidth = '190mm';
  holder.style.padding = '12px';
  holder.style.background = '#fff';
  holder.style.fontSize = '12px';
  holder.style.lineHeight = '1.55';
  holder.style.color = '#111';
  holder.style.whiteSpace = 'pre-wrap';
  holder.style.wordBreak = 'break-word';
  holder.style.fontFamily =
    '"Microsoft YaHei","PingFang SC","Segoe UI",SimSun,sans-serif';
  holder.innerHTML = html;
  document.body.appendChild(holder);

  const plainExtracted = (holder.innerText || holder.textContent || '').replace(
    /\r\n/g,
    '\n'
  );

  try {
    const hasRich = holder.querySelector(
      'img,table,svg,canvas,video,iframe,object,embed'
    );

    if (
      !hasRich &&
      plainExtracted.trim().length > 0 &&
      !containsCJK(plainExtracted)
    ) {
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'p' });
      const margin = 18;
      const pageW = pdf.internal.pageSize.getWidth();
      const maxW = pageW - margin * 2;
      pdf.setFontSize(11);
      writePlainTextToPdf(pdf, plainExtracted, margin, maxW, 5.6);
      return pdf.output('blob');
    }

    if (window.html2canvas) {
      const canvas = await html2canvas(holder, {
        scale: 1.85,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
      });
      return canvasToPagedPdfBlob(canvas);
    }
  } finally {
    holder.remove();
  }

  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const margin = 18;
  const pageW = pdf.internal.pageSize.getWidth();
  const maxW = pageW - margin * 2;
  pdf.setFontSize(11);
  writePlainTextToPdf(pdf, plainExtracted.trim() || ' ', margin, maxW, 5.6);
  return pdf.output('blob');
}

function exportDocxBlob(html) {
  const full = wrapHtmlDocument(normalizeHtmlForDocx(html));
  const lib = window.htmlDocx;
  if (lib && typeof lib.asBlob === 'function') return lib.asBlob(full);
  if (typeof window.asBlob === 'function') return window.asBlob(full);
  throw new Error(
    'DOCX 导出库未就绪。请刷新页面或更换网络；也可先导出为 .md / .pdf。'
  );
}

async function convertDocument(parsed, target) {
  const { html, text, rawMarkdown } = parsed;

  if (target === 'txt') {
    return {
      blob: new Blob(['\uFEFF', text], {
        type: 'text/plain;charset=utf-8',
      }),
      nameExt: 'txt',
    };
  }

  if (target === 'md') {
    let md;
    if (rawMarkdown) md = text;
    else {
      if (!window.TurndownService)
        throw new Error('Markdown 转换库未加载');
      const td = new TurndownService({ headingStyle: 'atx' });
      td.addRule('lineBreak', {
        filter: 'br',
        replacement: () => '  \n',
      });
      md = td.turndown(html);
    }
    return {
      blob: new Blob(['\uFEFF', md], {
        type: 'text/markdown;charset=utf-8',
      }),
      nameExt: 'md',
    };
  }

  if (target === 'docx') {
    const blob = exportDocxBlob(html);
    return { blob, nameExt: 'docx' };
  }

  if (target === 'pdf') {
    const blob = await exportPdfFromHtml(html);
    return { blob, nameExt: 'pdf' };
  }

  if (target === 'rtf') {
    const rtf = exportRtf(text);
    return {
      blob: new Blob([rtf], { type: 'application/rtf' }),
      nameExt: 'rtf',
    };
  }

  throw new Error('未知导出格式');
}

/* ---------- 文档模块 UI ---------- */

function initDocModule() {
  const fileInput = document.getElementById('doc-file');
  const fileName = document.getElementById('doc-file-name');
  const targetSel = document.getElementById('doc-target');
  const btn = document.getElementById('doc-convert');
  const progress = document.getElementById('doc-progress');
  const err = document.getElementById('doc-error');
  const result = document.getElementById('doc-result');
  const dl = document.getElementById('doc-download');

  let lastFile = null;
  let outBlob = null;
  let outName = 'converted';

  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    lastFile = f || null;
    fileName.textContent = f ? f.name : '未选择文件';
    showError(err, null);
    result.hidden = true;
    outBlob = null;
  });

  dl.addEventListener('click', () => {
    if (!outBlob) return;
    const name = `${outName}.${targetSel.value}`;
    window.saveAs(outBlob, name);
  });

  btn.addEventListener('click', async () => {
    if (!lastFile) {
      showError(err, '请先选择文件');
      return;
    }
    showError(err, null);
    result.hidden = true;
    outBlob = null;
    setProgress(progress, true, 5, '正在读取文档…');

    try {
      parseDocument.onProgress = (p) =>
        setProgress(progress, true, 10 + p * 0.4, `解析 PDF ${p}%`);
      const parsed = await parseDocument(lastFile);
      parseDocument.onProgress = null;

      setProgress(progress, true, 55, '正在转换格式…');
      const target = targetSel.value;
      const { blob, nameExt } = await convertDocument(parsed, target);
      outBlob = blob;
      outName = baseName(lastFile.name);
      if (outName.endsWith('.')) outName = outName.slice(0, -1);

      setProgress(progress, true, 100, '完成');
      result.hidden = false;
      setTimeout(() => {
        progress.hidden = true;
      }, 400);
    } catch (e) {
      parseDocument.onProgress = null;
      console.error(e);
      showError(err, e.message || String(e));
      progress.hidden = true;
    }
  });
}

/* ---------- 图片模块 ---------- */

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片无法解码'));
    };
    img.src = url;
  });
}

async function ensureRasterFile(file) {
  const ext = extOf(file.name);
  if (ext === 'heic' || ext === 'heif') {
    if (!window.heic2any)
      throw new Error('HEIC 需要 heic2any 库，请检查网络后刷新');
    const out = await heic2any({ blob: file, toType: 'image/png' });
    const blob = Array.isArray(out) ? out[0] : out;
    return blob;
  }
  return file;
}

function initImageModule() {
  const fileInput = document.getElementById('img-file');
  const fileName = document.getElementById('img-file-name');
  const previewSrc = document.getElementById('img-preview-src');
  const previewSrcPh = document.getElementById('img-preview-src-ph');
  const previewOut = document.getElementById('img-preview-out');
  const previewOutPh = document.getElementById('img-preview-out-ph');
  const targetSel = document.getElementById('img-target');
  const btn = document.getElementById('img-convert');
  const progress = document.getElementById('img-progress');
  const err = document.getElementById('img-error');
  const result = document.getElementById('img-result');
  const dl = document.getElementById('img-download');

  let lastBlob = null;
  let lastObjectUrl = null;
  let outBlob = null;
  let outObjectUrl = null;

  function clearOutPreview() {
    if (outObjectUrl) URL.revokeObjectURL(outObjectUrl);
    outObjectUrl = null;
    previewOut.src = '';
    previewOut.classList.remove('visible');
    previewOutPh.classList.remove('hidden');
    result.hidden = true;
  }

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    showError(err, null);
    clearOutPreview();
    if (!f) {
      fileName.textContent = '未选择图片';
      previewSrc.src = '';
      previewSrc.classList.remove('visible');
      previewSrcPh.classList.remove('hidden');
      lastBlob = null;
      return;
    }
    fileName.textContent = f.name;
    try {
      setProgress(progress, true, 0, '加载中…');
      const raster = await ensureRasterFile(f);
      lastBlob = raster;
      if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
      lastObjectUrl = URL.createObjectURL(raster);
      previewSrc.src = lastObjectUrl;
      previewSrc.classList.add('visible');
      previewSrcPh.classList.add('hidden');
    } catch (e) {
      console.error(e);
      showError(err, e.message || String(e));
      lastBlob = null;
    } finally {
      progress.hidden = true;
    }
  });

  btn.addEventListener('click', async () => {
    if (!lastBlob) {
      showError(err, '请先选择图片');
      return;
    }
    showError(err, null);
    setProgress(progress, true, 0, '转换中…');

    try {
      const mime = targetSel.value;
      const img = await loadImageFromFile(lastBlob);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const quality =
        mime === 'image/jpeg' || mime === 'image/webp' ? 0.92 : undefined;

      outBlob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('导出失败'))),
          mime,
          quality
        );
      });

      if (outObjectUrl) URL.revokeObjectURL(outObjectUrl);
      outObjectUrl = URL.createObjectURL(outBlob);
      previewOut.src = outObjectUrl;
      previewOut.classList.add('visible');
      previewOutPh.classList.add('hidden');
      result.hidden = false;
    } catch (e) {
      console.error(e);
      showError(err, e.message || String(e));
    } finally {
      progress.hidden = true;
    }
  });

  dl.addEventListener('click', () => {
    if (!outBlob) return;
    const map = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    };
    const ext = map[targetSel.value] || 'img';
    const base = fileInput.files[0]
      ? baseName(fileInput.files[0].name)
      : 'image';
    window.saveAs(outBlob, `${base}.${ext}`);
  });
}

/* ---------- 证件照：分割 + 裁剪 + 压缩 ---------- */

async function runSelfieOnce(imageElement) {
  let SelfieSegmentation;
  try {
    SelfieSegmentation = await loadSelfieSegmentationClass();
  } catch (e) {
    throw new Error(
      '无法加载人像分割组件（网络或 CDN 被拦截）。请用「打开网页.bat」以 http 方式打开，或检查代理/防火墙后重试。'
    );
  }

  return new Promise((resolve, reject) => {
    const ss = new SelfieSegmentation({
      locateFile: (file) => `${MEDIAPIPE_BASE}${file}`,
    });
    ss.setOptions({ modelSelection: 1 });
    let done = false;
    ss.onResults((results) => {
      if (done) return;
      done = true;
      try {
        ss.close();
      } catch (_) {
        /* ignore */
      }
      resolve(results);
    });
    const p = ss.send({ image: imageElement });
    if (p && typeof p.then === 'function') {
      p.catch((e) => {
        if (!done) {
          done = true;
          reject(e);
        }
      });
    }
    setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('人像分割超时，请换一张图或检查网络'));
      }
    }, 45000);
  });
}

/**
 * 将分割蒙版与背景合成；若蒙版语义为「背景高亮」，自动反转
 */
function compositePersonBackground(image, maskImage, bgHex) {
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);

  const mc = document.createElement('canvas');
  mc.width = w;
  mc.height = h;
  const mx = mc.getContext('2d');
  mx.drawImage(maskImage, 0, 0, w, h);
  const mData = mx.getImageData(0, 0, w, h);

  let sumEdge = 0;
  let cnt = 0;
  for (let y = 0; y < h; y += 8) {
    for (let x = 0; x < w; x += 8) {
      const i = (y * w + x) * 4;
      sumEdge += mData.data[i];
      cnt++;
    }
  }
  const avg = cnt ? sumEdge / cnt : 128;
  const invertMask = avg > 127;

  const { r: br, g: bg, b: bb } = hexToRgb(bgHex);

  for (let i = 0; i < imgData.data.length; i += 4) {
    let a = mData.data[i] / 255;
    if (invertMask) a = 1 - a;
    const inv = 1 - a;
    imgData.data[i] = Math.round(imgData.data[i] * a + br * inv);
    imgData.data[i + 1] = Math.round(imgData.data[i + 1] * a + bg * inv);
    imgData.data[i + 2] = Math.round(imgData.data[i + 2] * a + bb * inv);
    imgData.data[i + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

/** 根据 alpha/亮度估计人像包围盒（简化） */
function bboxFromMask(maskImage, w, h, invertMask) {
  const mc = document.createElement('canvas');
  mc.width = w;
  mc.height = h;
  const mx = mc.getContext('2d');
  mx.drawImage(maskImage, 0, 0, w, h);
  const d = mx.getImageData(0, 0, w, h).data;
  let minX = w,
    minY = h,
    maxX = 0,
    maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = d[(y * w + x) * 4] / 255;
      if (invertMask) v = 1 - v;
      if (v > 0.35) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX <= minX || maxY <= minY) return { x: 0, y: 0, w, h };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function cropToAspectAndResize(
  sourceCanvas,
  targetW,
  targetH,
  maskImageForBBox,
  invertMask
) {
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  const aspect = targetW / targetH;

  let box = { x: 0, y: 0, w: sw, h: sh };
  if (maskImageForBBox) {
    box = bboxFromMask(maskImageForBBox, sw, sh, invertMask);
    const padX = box.w * 0.08;
    const padY = box.h * 0.12;
    box.x = Math.max(0, box.x - padX);
    box.y = Math.max(0, box.y - padY);
    box.w = Math.min(sw - box.x, box.w + padX * 2);
    box.h = Math.min(sh - box.y, box.h + padY * 2);
  }

  let cw = box.w;
  let ch = box.h;
  const curAspect = cw / ch;
  if (curAspect > aspect) {
    cw = ch * aspect;
  } else {
    ch = cw / aspect;
  }

  let cx = box.x + (box.w - cw) / 2;
  let cy = box.y + (box.h - ch) / 2;
  cy = Math.max(0, Math.min(sh - ch, cy - ch * 0.06));

  cx = Math.max(0, Math.min(sw - cw, cx));

  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(
    sourceCanvas,
    cx,
    cy,
    cw,
    ch,
    0,
    0,
    targetW,
    targetH
  );
  return out;
}

/** 简易兜底：无分割时按比例居中裁剪并铺满目标画布 */
function fallbackPassport(image, bgHex, targetW, targetH) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  const aspect = targetW / targetH;
  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = bgHex;
  ctx.fillRect(0, 0, targetW, targetH);
  const ir = iw / ih;
  let sw;
  let sh;
  let sx;
  let sy;
  if (ir > aspect) {
    sh = ih;
    sw = ih * aspect;
    sx = (iw - sw) / 2;
    sy = 0;
  } else {
    sw = iw;
    sh = iw / aspect;
    sx = 0;
    sy = (ih - sh) / 2;
  }
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, targetW, targetH);
  return out;
}

async function jpegBlobInRange(canvas, minBytes, maxBytes) {
  let q = 0.88;
  let blob = await new Promise((res) =>
    canvas.toBlob(res, 'image/jpeg', q)
  );
  if (!blob) throw new Error('无法生成 JPG');

  for (let i = 0; i < 28 && blob.size > maxBytes; i++) {
    q -= 0.03;
    if (q < 0.35) break;
    blob = await new Promise((res) =>
      canvas.toBlob(res, 'image/jpeg', q)
    );
  }
  for (let j = 0; j < 12 && blob.size < minBytes && q < 0.98; j++) {
    q = Math.min(0.98, q + 0.02);
    blob = await new Promise((res) =>
      canvas.toBlob(res, 'image/jpeg', q)
    );
  }
  return { blob, quality: q, size: blob.size };
}

function initPhotoModule() {
  const fileInput = document.getElementById('photo-file');
  const fileName = document.getElementById('photo-file-name');
  const bgWhite = document.getElementById('bg-white');
  const bgBlue = document.getElementById('bg-blue');
  const btn = document.getElementById('photo-generate');
  const progress = document.getElementById('photo-progress');
  const err = document.getElementById('photo-error');
  const meta = document.getElementById('photo-meta');
  const result = document.getElementById('photo-result');
  const dl = document.getElementById('photo-download');
  const canvas = document.getElementById('photo-canvas');
  const ph = document.getElementById('photo-ph');

  let bgMode = 'white';
  let lastImg = null;
  let outBlob = null;

  function setBgButtons() {
    bgWhite.classList.toggle('active', bgMode === 'white');
    bgBlue.classList.toggle('active', bgMode === 'blue');
  }

  bgWhite.addEventListener('click', () => {
    bgMode = 'white';
    setBgButtons();
  });
  bgBlue.addEventListener('click', () => {
    bgMode = 'blue';
    setBgButtons();
  });

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    showError(err, null);
    meta.hidden = true;
    result.hidden = true;
    outBlob = null;
    if (!f) {
      fileName.textContent = '未选择';
      lastImg = null;
      ph.classList.remove('hidden');
      canvas.classList.remove('visible');
      return;
    }
    fileName.textContent = f.name;
    try {
      const raster = await ensureRasterFile(f);
      lastImg = await loadImageFromFile(raster);
      ph.classList.remove('hidden');
      canvas.classList.remove('visible');
    } catch (e) {
      console.error(e);
      showError(err, e.message || String(e));
      lastImg = null;
    }
  });

  btn.addEventListener('click', async () => {
    if (!lastImg) {
      showError(err, '请先上传照片');
      return;
    }
    showError(err, null);
    meta.hidden = true;
    result.hidden = true;
    outBlob = null;
    setProgress(progress, true, 0, '处理中…');

    const bgHex = bgMode === 'blue' ? CET_BLUE : CET_WHITE;
    const W = 480;
    const H = 640;

    try {
      let composed;
      let maskForBBox = null;
      let invertForBBox = false;

      try {
        setProgress(progress, true, 20, '人像分割（首次需下载模型）…');
        const results = await runSelfieOnce(lastImg);
        const mask = results.segmentationMask;
        maskForBBox = mask;
        composed = compositePersonBackground(lastImg, mask, bgHex);

        const mc = document.createElement('canvas');
        mc.width = composed.width;
        mc.height = composed.height;
        mc.getContext('2d').drawImage(mask, 0, 0, mc.width, mc.height);
        const samp = mc
          .getContext('2d')
          .getImageData(0, 0, mc.width, mc.height).data;
        let s = 0,
          c = 0;
        for (let i = 0; i < samp.length; i += 16) {
          s += samp[i];
          c++;
        }
        invertForBBox = c ? s / c > 127 : false;
      } catch (segErr) {
        console.warn('分割失败，使用居中裁剪兜底', segErr);
        composed = fallbackPassport(lastImg, bgHex, W, H);
        const ctx = canvas.getContext('2d');
        canvas.width = W;
        canvas.height = H;
        ctx.drawImage(composed, 0, 0);
        ph.classList.add('hidden');
        canvas.classList.add('visible');

        const pack = await jpegBlobInRange(canvas, 20 * 1024, 100 * 1024);
        outBlob = pack.blob;
        meta.hidden = false;
        meta.textContent = `尺寸 ${W}×${H} 像素，约 ${Math.round(
          pack.size / 1024
        )} KB，JPEG 质量约 ${pack.quality.toFixed(2)}（兜底裁剪，建议换纯色背景照片或检查网络以启用抠图）`;
        result.hidden = false;
        progress.hidden = true;
        return;
      }

      setProgress(progress, true, 70, '裁剪为标准比例并输出 480×640…');
      const finalCanvas = cropToAspectAndResize(
        composed,
        W,
        H,
        maskForBBox,
        invertForBBox
      );

      const ctx = canvas.getContext('2d');
      canvas.width = W;
      canvas.height = H;
      ctx.drawImage(finalCanvas, 0, 0);
      ph.classList.add('hidden');
      canvas.classList.add('visible');

      const pack = await jpegBlobInRange(canvas, 20 * 1024, 100 * 1024);
      outBlob = pack.blob;
      meta.hidden = false;
      meta.textContent = `尺寸 ${W}×${H} 像素，约 ${Math.round(
        pack.size / 1024
      )} KB，JPEG 质量约 ${pack.quality.toFixed(
        2
      )}。若报名系统对体积要求极严，可略调原图复杂度后重试。`;
      result.hidden = false;
    } catch (e) {
      console.error(e);
      showError(err, e.message || String(e));
    } finally {
      progress.hidden = true;
    }
  });

  dl.addEventListener('click', () => {
    if (!outBlob) return;
    const name = fileInput.files[0]
      ? `${baseName(fileInput.files[0].name)}_cet.jpg`
      : 'cet_photo.jpg';
    window.saveAs(outBlob, name);
  });
}

/* ---------- 启动 ---------- */

function initGlobals() {
  ensurePdfWorker();
}

function boot() {
  initNav();
  initGlobals();
  initDocModule();
  initImageModule();
  initPhotoModule();
}

try {
  boot();
} catch (e) {
  console.error(e);
  const msg = document.createElement('p');
  msg.className = 'error';
  msg.style.cssText = 'margin:1rem;padding:1rem;background:#fdecea;border-radius:8px;';
  msg.textContent =
    '页面脚本未正常启动：' +
    (e && e.message ? e.message : String(e)) +
    '。请尝试刷新或用「打开网页.bat」通过 http 打开。';
  document.body.prepend(msg);
}
