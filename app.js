'use strict';

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────
const S = {
  view: 'shelf',
  books: [],
  currentBook: null,
  currentChapter: 0,
  vocabulary: [],
  fontSize: parseInt(localStorage.getItem('font_size') || '18'),
  darkMode: localStorage.getItem('dark_mode') === 'true',
  pendingTranslation: null,   // { word, translation, meaning, sentence }
  savedSelText: null,         // { text, context, sentence }
  pendingLookup: null,        // 查词页待保存的词条
  quizQuestions: [],
  quizIndex: 0,
  quizCorrect: 0,
  quizAnswered: false,
  readingTimer: null,         // 打卡计时器
  historyMonth: null,         // 打卡历史当前查看月份
};

// ─────────────────────────────────────────
// DATABASE (IndexedDB)
// ─────────────────────────────────────────
let db;

function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('reading_app', 2);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('vocabulary'))
        d.createObjectStore('vocabulary', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('books'))
        d.createObjectStore('books', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll(store) {
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function dbAdd(store, data) {
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).add(data);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function dbDelete(store, id) {
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).delete(id);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}

function dbPut(store, data) {
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).put(data);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function dbClear(store) {
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).clear();
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}

// ─────────────────────────────────────────
// EPUB PARSER
// ─────────────────────────────────────────
async function parseEpub(file) {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const parser = new DOMParser();

  // 1. container.xml → OPF path
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('无效 EPUB：找不到 container.xml');
  const containerDoc = parser.parseFromString(await containerFile.async('string'), 'application/xml');
  const rootfileEl = containerDoc.querySelector('rootfile');
  if (!rootfileEl) throw new Error('无效 EPUB：找不到 rootfile');
  const opfPath = rootfileEl.getAttribute('full-path');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  // 2. OPF → manifest + spine
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error('找不到 OPF 文件');
  const opfDoc = parser.parseFromString(await opfFile.async('string'), 'application/xml');

  const titleEl = opfDoc.querySelector('title');
  const title = titleEl ? titleEl.textContent.trim() : file.name.replace('.epub', '');

  const manifest = {};
  opfDoc.querySelectorAll('manifest item').forEach(el => {
    manifest[el.getAttribute('id')] = el.getAttribute('href');
  });

  const spineIds = [];
  opfDoc.querySelectorAll('spine itemref').forEach(el => spineIds.push(el.getAttribute('idref')));

  // 3. load chapter HTML
  const chapters = [];
  for (const id of spineIds) {
    const href = manifest[id];
    if (!href) continue;
    const paths = [opfDir + href, href, decodeURIComponent(opfDir + href)];
    let f = null;
    for (const p of paths) { f = zip.file(p); if (f) break; }
    if (!f) continue;

    const html = await f.async('string');
    const doc = parser.parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, link, img, figure, svg').forEach(el => el.remove());
    doc.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));
    doc.querySelectorAll('[class]').forEach(el => el.removeAttribute('class'));

    const body = doc.body;
    if (!body) continue;
    const text = body.textContent.trim();
    if (text.length < 80) continue; // skip cover/toc placeholder pages

    const h = body.querySelector('h1, h2, h3');
    chapters.push({
      title: h ? h.textContent.trim().slice(0, 60) : `第 ${chapters.length + 1} 章`,
      html: body.innerHTML,
    });
  }

  if (chapters.length === 0) throw new Error('解析失败：未找到文字内容，请确认 EPUB 格式正确');
  return { title, chapters };
}

// ─────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  const nav = document.getElementById('bottom-nav');
  nav.style.display = ['shelf', 'lookup', 'vocab'].includes(name) ? 'flex' : 'none';
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  S.view = name;

  // 打卡：只有在阅读页才计时
  if (name === 'reader') startReadingTimer();
  else stopReadingTimer();
  if (name === 'shelf') renderCheckinStrip();
}

// ─────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────
let _toastTimer;
function toast(msg, ms = 2200, noNav = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.toggle('no-nav', noNav);
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

// ─────────────────────────────────────────
// SHELF
// ─────────────────────────────────────────
async function loadShelf() {
  S.books = await dbGetAll('books');
  renderShelf();
}

function renderShelf() {
  renderCheckinStrip();
  const list = document.getElementById('book-list');
  if (!S.books.length) {
    list.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">📚</div>
      <div class="empty-text">还没有书籍<br>点击下方导入 EPUB 开始阅读</div>
    </div>`;
    return;
  }
  const tapeColors = ['tape-pink', 'tape-blue', 'tape-lav'];
  const tapePos    = ['tape-tl',  'tape-tr'];
  const tapeTypes  = ['tape-dots','tape-plain'];
  list.innerHTML = S.books.map((b, i) => `
    <div class="book-card" data-id="${b.id}">
      <div class="tape ${tapeTypes[i%2]} ${tapeColors[i%3]} ${tapePos[i%2]}"></div>
      <button class="book-delete" data-del="${b.id}" title="删除">✕</button>
      <div class="book-cover">📖</div>
      <div class="book-name">${esc(b.title)}</div>
      <div class="book-meta">${b.chapters.length} 章节</div>
    </div>
  `).join('');

  list.querySelectorAll('.book-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('book-delete')) return;
      const book = S.books.find(b => b.id === +card.dataset.id);
      if (book) openBook(book);
    });
  });
  list.querySelectorAll('.book-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('确定删除这本书？书签和单词不会受影响。')) return;
      await dbDelete('books', +btn.dataset.del);
      S.books = S.books.filter(b => b.id !== +btn.dataset.del);
      renderShelf();
    });
  });
}

async function importBook(file) {
  toast('正在解析书籍，请稍候…', 15000);
  try {
    const data = await parseEpub(file);
    const id = await dbAdd('books', data);
    data.id = id;
    S.books.push(data);
    renderShelf();
    toast(`《${data.title}》导入成功，共 ${data.chapters.length} 章`);
  } catch (err) {
    toast('导入失败：' + err.message, 4000);
  }
}

// ─────────────────────────────────────────
// READER
// ─────────────────────────────────────────
function openBook(book) {
  S.currentBook = book;
  S.currentChapter = parseInt(localStorage.getItem(`pos_${book.id}`) || '0');
  document.getElementById('book-title-display').textContent = book.title;
  showView('reader');      // 先显示阅读页，否则隐藏状态下无法定位滚动条
  renderChapter(true);
}

function renderChapter(restoreScroll = false) {
  const book = S.currentBook;
  const ch = book.chapters[S.currentChapter];
  document.getElementById('chapter-info').textContent = ch.title;
  document.getElementById('chapter-counter').textContent =
    `${S.currentChapter + 1} / ${book.chapters.length}`;
  document.getElementById('prev-chapter').disabled = S.currentChapter === 0;
  document.getElementById('next-chapter').disabled = S.currentChapter === book.chapters.length - 1;

  const rc = document.getElementById('reader-content');
  rc.innerHTML = ch.html;
  rc.style.fontSize = S.fontSize + 'px';

  localStorage.setItem(`pos_${book.id}`, S.currentChapter);
  hideTranslateBtn();
  highlightVocabWords(rc);
  insertSummaryBar(rc);

  // 恢复上次滚动位置（重开书时），否则回到章节顶部
  if (restoreScroll) {
    const saved = parseInt(localStorage.getItem(`scroll_${book.id}_${S.currentChapter}`) || '0');
    rc.scrollTop = saved;
    // 等这一帧布局完成后再定位一次，确保长章节也能跳准
    requestAnimationFrame(() => { rc.scrollTop = saved; });
  } else {
    rc.scrollTop = 0;
  }
}

function highlightVocabWords(container) {
  if (!S.vocabulary.length) return;

  const words = new Set();
  S.vocabulary.forEach(v => {
    if (v.word && v.word.length > 1) words.add(v.word.trim());
    if (v.baseForm && v.baseForm.length > 1) words.add(v.baseForm.trim());
  });
  if (!words.size) return;

  const pattern = [...words]
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const regex = new RegExp(`\\b(${pattern})\\b`, 'gi');

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  for (const node of nodes) {
    const txt = node.textContent;
    if (!regex.test(txt)) { regex.lastIndex = 0; continue; }
    regex.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = regex.exec(txt)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m.index)));
      const span = document.createElement('span');
      span.className = 'vocab-hl';
      span.textContent = m[0];
      frag.appendChild(span);
      last = m.index + m[0].length;
    }
    if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

// ─────────────────────────────────────────
// TEXT SELECTION + TRANSLATION
// ─────────────────────────────────────────
function getWordAtPoint(x, y) {
  const range = document.caretRangeFromPoint
    ? document.caretRangeFromPoint(x, y)
    : (() => {
        const pos = document.caretPositionFromPoint && document.caretPositionFromPoint(x, y);
        if (!pos) return null;
        const r = document.createRange();
        r.setStart(pos.offsetNode, pos.offset);
        r.collapse(true);
        return r;
      })();
  if (!range) return null;

  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.textContent;
  let s = range.startOffset;
  let e = s;
  if (s === text.length && s > 0) s--;

  while (s > 0 && /[a-zA-Z'']/.test(text[s - 1])) s--;
  while (e < text.length && /[a-zA-Z'']/.test(text[e])) e++;

  const word = text.slice(s, e).replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '');
  return word.length > 0 ? { word, node } : null;
}

function setupSelection() {
  const rc = document.getElementById('reader-content');
  const btn = document.getElementById('translate-btn');
  let tapStart = { time: 0, x: 0, y: 0 };

  rc.addEventListener('touchstart', (e) => {
    tapStart = { time: Date.now(), x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });

  rc.addEventListener('touchend', (e) => {
    const dt = Date.now() - tapStart.time;
    const touch = e.changedTouches[0];
    const dx = Math.abs(touch.clientX - tapStart.x);
    const dy = Math.abs(touch.clientY - tapStart.y);
    if (dt > 320 || dx > 10 || dy > 10) return;

    // 已收藏的高亮词：本地显示释义并可移除，不联网
    const hitEl = document.elementFromPoint(touch.clientX, touch.clientY);
    const hlSpan = hitEl && hitEl.closest ? hitEl.closest('.vocab-hl') : null;
    if (hlSpan) {
      const entry = findVocabEntry(hlSpan.textContent);
      if (entry) { e.preventDefault(); openLocalPopup(entry); return; }
    }

    const result = getWordAtPoint(touch.clientX, touch.clientY);
    if (!result) return;
    e.preventDefault();

    const { word, node } = result;
    let para = node.parentElement;
    while (para && para !== rc && !['P','DIV','SECTION','BLOCKQUOTE','LI'].includes(para.tagName)) {
      para = para.parentElement;
    }
    const context = para ? para.textContent.trim() : word;
    S.savedSelText = { text: word, context, sentence: extractSentence(context, word) };
    openPopup(S.savedSelText);
  }, { passive: false });

  // 长按框选短语：选中超过3个字符时显示翻译按钮
  document.addEventListener('selectionchange', () => {
    if (S.view !== 'reader') return;
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';

    if (text.length > 3) {
      try {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        let para = range.commonAncestorContainer;
        if (para.nodeType === Node.TEXT_NODE) para = para.parentElement;
        while (para && para !== rc && !['P','DIV','SECTION','BLOCKQUOTE','LI'].includes(para.tagName)) {
          para = para.parentElement;
        }
        const context = para ? para.textContent.trim() : text;
        S.savedSelText = { text, context, sentence: extractSentence(context, text) };

        const top = Math.max(rect.top - 48, 60);
        const left = Math.min(Math.max(rect.left + rect.width / 2 - 36, 8), window.innerWidth - 90);
        btn.style.top = top + 'px';
        btn.style.left = left + 'px';
        btn.classList.remove('hidden');
      } catch (_) {}
    } else {
      setTimeout(() => {
        if (!window.getSelection().toString().trim()) hideTranslateBtn();
      }, 200);
    }
  });

  btn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  btn.addEventListener('touchend', (e) => { e.preventDefault(); triggerTranslation(); });
  btn.addEventListener('click', triggerTranslation);

  // 滚动时隐藏翻译按钮，并记录阅读位置
  let scrollSaveTimer;
  rc.addEventListener('scroll', () => {
    hideTranslateBtn();
    if (!S.currentBook) return;
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => {
      localStorage.setItem(`scroll_${S.currentBook.id}_${S.currentChapter}`, rc.scrollTop);
    }, 200);
  });
}

function hideTranslateBtn() {
  document.getElementById('translate-btn').classList.add('hidden');
}

function extractSentence(fullText, target) {
  const sentences = fullText.match(/[^.!?…]+[.!?…]+/g) || [];
  for (const s of sentences) {
    if (s.includes(target)) {
      const clauses = s.split(/[,，;；:：]/);
      for (const c of clauses) {
        if (c.includes(target)) return c.trim();
      }
      return s.trim();
    }
  }
  const i = fullText.indexOf(target);
  if (i >= 0) {
    const start = Math.max(0, i - 80);
    const end = Math.min(fullText.length, i + target.length + 80);
    return fullText.slice(start, end).trim();
  }
  return fullText.slice(0, 200).trim();
}

async function triggerTranslation() {
  if (!S.savedSelText) return;
  hideTranslateBtn();
  openPopup(S.savedSelText);
}

async function openPopup(sel) {
  const popup = document.getElementById('translation-popup');
  const wordEl = document.getElementById('popup-word');
  const bodyEl = document.getElementById('popup-body');
  const saveBtn = document.getElementById('save-word-btn');

  wordEl.textContent = sel.text;
  bodyEl.innerHTML = '<div class="loading-spinner"></div>';
  saveBtn.style.display = 'none';
  document.getElementById('remove-word-btn').style.display = 'none';
  S.pendingTranslation = null;
  popup.classList.remove('hidden');

  const apiKey = localStorage.getItem('deepseek_api_key');
  if (!apiKey) {
    bodyEl.textContent = '请先到「设置」页面输入 DeepSeek API Key';
    return;
  }

  try {
    const raw = await callDeepSeek(sel.text, sel.context, apiKey);
    const parsed = parseTranslation(raw);
    S.pendingTranslation = {
      word: sel.text,
      baseForm: parsed.baseForm,
      phonetic: parsed.phonetic,
      translation: parsed.quizTranslation,
      defs: parsed.defs,
      meaning: parsed.contextExpl,
      sentence: sel.sentence,
    };
    bodyEl.innerHTML = renderTranslationHtml(parsed);
    saveBtn.style.display = 'block';
  } catch (err) {
    bodyEl.textContent = '翻译失败：' + err.message;
  }
}

async function callDeepSeek(word, context, apiKey) {
  const isPhrase = word.includes(' ') || word.length > 20;

  const singleWordFmt =
`原型：[动词原形/名词单数等基本形式]
音标：/[IPA国际音标]/
[词性]. [中文含义]
[词性]. [中文含义]
（列出2-5个主要词义，每行一个，词性用vi/vt/n/adj/adv等缩写）

结合上下文
[40字以内，说明该词在此处的含义和语境]`;

  const phraseFmt =
`翻译：[流畅的中文翻译]

结合上下文
[40字以内，说明该短语/句子在此处的含义和语境]`;

  const prompt =
`你是英文阅读助手。用户在阅读英文小说时选中了一段文字，请分析并翻译。

书中原文（上下文）：
"${context.slice(0, 500)}"

选中内容：「${word}」

请严格按以下格式回复，不添加任何其他内容：
${isPhrase ? phraseFmt : singleWordFmt}`;

  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 280,
      temperature: 0.2,
    }),
  });

  if (resp.status === 401) throw new Error('API Key 无效，请在设置中检查');
  if (resp.status === 429) throw new Error('请求太频繁，请稍后再试');
  if (!resp.ok) throw new Error(`请求失败 (${resp.status})`);

  const data = await resp.json();
  return data.choices[0].message.content.trim();
}

function parseTranslation(text) {
  const lines = text.split('\n');
  let baseForm = '', phonetic = '', translation = '', contextExpl = '';
  const defs = [];
  let inContext = false;
  const ctxLines = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('原型：')) { baseForm = line.slice(3).trim(); continue; }
    if (line.startsWith('音标：')) { phonetic = line.slice(3).trim(); continue; }
    if (line.startsWith('翻译：')) { translation = line.slice(3).trim(); continue; }
    if (line === '结合上下文') { inContext = true; continue; }
    if (inContext) { ctxLines.push(line); continue; }
    if (baseForm && /^[a-z]+[./]/.test(line)) defs.push(line);
  }

  contextExpl = ctxLines.join(' ');

  // 提取简短中文用于背单词选项
  let quizTranslation = translation;
  if (!quizTranslation && defs.length > 0) {
    quizTranslation = defs[0].replace(/^[a-z]+[./]\s*/i, '').split(/[,，]/)[0].trim();
  }

  return { baseForm, phonetic, defs, translation, contextExpl, quizTranslation, raw: text };
}

function renderTranslationHtml(p) {
  if (p.baseForm || p.defs.length > 0) {
    return `
      <div class="t-head-row">
        ${p.baseForm ? `<span class="t-base-word">${esc(p.baseForm)}</span>` : ''}
        ${p.phonetic ? `<span class="t-phonetic">${esc(p.phonetic)}</span>` : ''}
      </div>
      <div class="t-defs">${p.defs.map(d => `<div class="t-def">${esc(d)}</div>`).join('')}</div>
      ${p.contextExpl ? `<div class="t-label">结合上下文</div><div class="t-context">${esc(p.contextExpl)}</div>` : ''}
    `.trim();
  }
  return `
    <div class="t-translation">${esc(p.translation || p.raw)}</div>
    ${p.contextExpl ? `<div class="t-label">结合上下文</div><div class="t-context">${esc(p.contextExpl)}</div>` : ''}
  `.trim();
}

async function saveWord() {
  if (!S.pendingTranslation) return;
  const pt = S.pendingTranslation;
  const dup = S.vocabulary.find(v => v.word.toLowerCase() === pt.word.toLowerCase());
  if (dup) { toast('这个词已经在单词库里了'); return; }

  const entry = {
    word: pt.word,
    baseForm: pt.baseForm || '',
    phonetic: pt.phonetic || '',
    defs: pt.defs || [],
    translation: pt.translation || '',
    meaning: pt.meaning || '',
    sentence: pt.sentence || '',
    bookTitle: S.currentBook ? S.currentBook.title : '',
    dateAdded: Date.now(),
    reviewLevel: 0,
    nextReview: Date.now(),
  };
  const id = await dbAdd('vocabulary', entry);
  entry.id = id;
  S.vocabulary.push(entry);
  document.getElementById('translation-popup').classList.add('hidden');
  toast('已保存到单词库');
}

// 从词条提取简短的背单词显示标签（15字以内）
function quizLabel(v) {
  if (v.defs && v.defs.length > 0) {
    const chinese = v.defs[0].replace(/^[a-z]+[./]\s*/i, '').split(/[,，]/)[0].trim();
    return chinese.slice(0, 15);
  }
  const t = v.translation || '';
  return t.length > 18 ? t.slice(0, 16) + '…' : t;
}

// ─────────────────────────────────────────
// LOOKUP (查词)
// ─────────────────────────────────────────
async function doLookup() {
  const input = document.getElementById('lookup-input');
  const resultEl = document.getElementById('lookup-result');
  const word = input.value.trim();
  if (!word) { toast('请输入要查的英文'); return; }

  const apiKey = localStorage.getItem('deepseek_api_key');
  if (!apiKey) {
    resultEl.innerHTML = '<div class="lookup-tip">请先到「设置」页面输入 DeepSeek API Key</div>';
    return;
  }

  resultEl.innerHTML = '<div class="loading-spinner"></div>';
  S.pendingLookup = null;

  try {
    const raw = await callDeepSeekLookup(word, apiKey);
    const parsed = parseLookup(raw);
    S.pendingLookup = {
      word,
      baseForm: parsed.baseForm,
      phonetic: parsed.phonetic,
      translation: parsed.quizTranslation,
      defs: parsed.defs,
      meaning: parsed.exampleZh,
      sentence: parsed.exampleEn,
    };
    resultEl.innerHTML = renderLookupHtml(parsed) +
      '<button id="lookup-save-btn" class="primary-btn" style="margin-top:14px">保存到单词库</button>';
    document.getElementById('lookup-save-btn').addEventListener('click', saveLookupWord);
  } catch (err) {
    resultEl.innerHTML = '<div class="lookup-tip">查询失败：' + esc(err.message) + '</div>';
  }
}

async function callDeepSeekLookup(word, apiKey) {
  const isPhrase = word.includes(' ') || word.length > 20;

  const singleWordFmt =
`原型：[动词原形/名词单数等基本形式]
音标：/[IPA国际音标]/
[词性]. [中文含义]
[词性]. [中文含义]
（列出2-5个主要词义，每行一个，词性用vi/vt/n/adj/adv等缩写）

例句
[一句包含该词的英文例句，20个单词以内]
[这句英文例句的中文翻译]`;

  const phraseFmt =
`翻译：[流畅的中文翻译]

例句
[一句包含该短语的英文例句，20个单词以内]
[这句英文例句的中文翻译]`;

  const prompt =
`你是英文词典助手。用户想查一个英文${isPhrase ? '短语' : '单词'}，没有上下文，请你分析并给出释义，再自己造一句简短例句帮助理解。

要查的内容：「${word}」

请严格按以下格式回复，不添加任何其他内容：
${isPhrase ? phraseFmt : singleWordFmt}`;

  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 280,
      temperature: 0.3,
    }),
  });

  if (resp.status === 401) throw new Error('API Key 无效，请在设置中检查');
  if (resp.status === 429) throw new Error('请求太频繁，请稍后再试');
  if (!resp.ok) throw new Error(`请求失败 (${resp.status})`);

  const data = await resp.json();
  return data.choices[0].message.content.trim();
}

function parseLookup(text) {
  const lines = text.split('\n');
  let baseForm = '', phonetic = '', translation = '';
  const defs = [];
  let inExample = false;
  const exampleLines = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('原型：')) { baseForm = line.slice(3).trim(); continue; }
    if (line.startsWith('音标：')) { phonetic = line.slice(3).trim(); continue; }
    if (line.startsWith('翻译：')) { translation = line.slice(3).trim(); continue; }
    if (line === '例句') { inExample = true; continue; }
    if (inExample) { exampleLines.push(line); continue; }
    if (baseForm && /^[a-z]+[./]/.test(line)) defs.push(line);
  }

  // 例句两行：第一行英文，第二行中文（按是否含中文字符判断）
  let exampleEn = '', exampleZh = '';
  for (const l of exampleLines) {
    if (/[一-龥]/.test(l)) exampleZh = exampleZh ? exampleZh + l : l;
    else exampleEn = exampleEn ? exampleEn + ' ' + l : l;
  }

  let quizTranslation = translation;
  if (!quizTranslation && defs.length > 0) {
    quizTranslation = defs[0].replace(/^[a-z]+[./]\s*/i, '').split(/[,，]/)[0].trim();
  }

  return { baseForm, phonetic, defs, translation, exampleEn, exampleZh, quizTranslation, raw: text };
}

function renderLookupHtml(p) {
  const head = (p.baseForm || p.defs.length > 0)
    ? `
      <div class="t-head-row">
        ${p.baseForm ? `<span class="t-base-word">${esc(p.baseForm)}</span>` : ''}
        ${p.phonetic ? `<span class="t-phonetic">${esc(p.phonetic)}</span>` : ''}
      </div>
      <div class="t-defs">${p.defs.map(d => `<div class="t-def">${esc(d)}</div>`).join('')}</div>`
    : `<div class="t-translation">${esc(p.translation || p.raw)}</div>`;

  const example = (p.exampleEn || p.exampleZh)
    ? `<div class="t-label">例句</div>
       ${p.exampleEn ? `<div class="t-example-en">${esc(p.exampleEn)}</div>` : ''}
       ${p.exampleZh ? `<div class="t-context">${esc(p.exampleZh)}</div>` : ''}`
    : '';

  return (head + example).trim();
}

async function saveLookupWord() {
  if (!S.pendingLookup) return;
  const pt = S.pendingLookup;
  const dup = S.vocabulary.find(v => v.word.toLowerCase() === pt.word.toLowerCase());
  if (dup) { toast('这个词已经在单词库里了'); return; }

  const entry = {
    word: pt.word,
    baseForm: pt.baseForm || '',
    phonetic: pt.phonetic || '',
    defs: pt.defs || [],
    translation: pt.translation || '',
    meaning: pt.meaning || '',
    sentence: pt.sentence || '',
    bookTitle: '',
    dateAdded: Date.now(),
    reviewLevel: 0,
    nextReview: Date.now(),
  };
  const id = await dbAdd('vocabulary', entry);
  entry.id = id;
  S.vocabulary.push(entry);
  toast('已保存到单词库');
}

// ─────────────────────────────────────────
// 已收藏词：本地弹窗 + 移除（功能2/3，离线可用）
// ─────────────────────────────────────────
function findVocabEntry(text) {
  const t = text.trim().toLowerCase();
  return S.vocabulary.find(v =>
    (v.word && v.word.toLowerCase() === t) ||
    (v.baseForm && v.baseForm.toLowerCase() === t)
  );
}

function openLocalPopup(entry) {
  const popup = document.getElementById('translation-popup');
  const wordEl = document.getElementById('popup-word');
  const bodyEl = document.getElementById('popup-body');
  const saveBtn = document.getElementById('save-word-btn');
  const removeBtn = document.getElementById('remove-word-btn');

  wordEl.textContent = entry.word;
  bodyEl.innerHTML = renderVocabPopupHtml(entry);
  saveBtn.style.display = 'none';
  removeBtn.style.display = 'block';
  removeBtn.onclick = () => removeVocabWord(entry.id);
  popup.classList.remove('hidden');
}

function renderVocabPopupHtml(v) {
  const head = (v.baseForm || v.phonetic) ? `
    <div class="t-head-row">
      ${v.baseForm ? `<span class="t-base-word">${esc(v.baseForm)}</span>` : ''}
      ${v.phonetic ? `<span class="t-phonetic">${esc(v.phonetic)}</span>` : ''}
    </div>` : '';
  const defs = (v.defs && v.defs.length)
    ? `<div class="t-defs">${v.defs.map(d => `<div class="t-def">${esc(d)}</div>`).join('')}</div>`
    : (v.translation ? `<div class="t-translation">${esc(v.translation)}</div>` : '');
  const meaning = v.meaning ? `<div class="t-label">结合上下文</div><div class="t-context">${esc(v.meaning)}</div>` : '';
  return (head + defs + meaning).trim() || '（这个词没有存释义）';
}

async function removeVocabWord(id) {
  await dbDelete('vocabulary', id);
  S.vocabulary = S.vocabulary.filter(v => v.id !== id);
  document.getElementById('translation-popup').classList.add('hidden');
  if (S.view === 'reader' && S.currentBook) {
    const rc = document.getElementById('reader-content');
    const keep = rc.scrollTop;
    renderChapter();
    rc.scrollTop = keep;
  }
  toast('已从单词库移除');
}

// ─────────────────────────────────────────
// 本章摘要（功能4，结果缓存省钱）
// ─────────────────────────────────────────
function insertSummaryBar(rc) {
  const bar = document.createElement('div');
  bar.className = 'summary-bar';
  bar.innerHTML =
    `<button type="button" class="summary-btn" id="summary-btn">本章摘要</button>
     <div class="summary-text hidden" id="summary-text"></div>`;
  rc.insertAdjacentElement('afterbegin', bar);
  const key = `summary_${S.currentBook.id}_${S.currentChapter}`;
  document.getElementById('summary-btn').addEventListener('click', () => toggleSummary(key));
}

async function toggleSummary(key) {
  const out = document.getElementById('summary-text');
  const cached = localStorage.getItem(key);
  if (cached) {
    out.textContent = cached;
    out.classList.toggle('hidden');
    return;
  }
  const apiKey = localStorage.getItem('deepseek_api_key');
  if (!apiKey) { toast('请先到「设置」页面输入 API Key'); return; }

  const ch = S.currentBook.chapters[S.currentChapter];
  const tmp = document.createElement('div');
  tmp.innerHTML = ch.html;
  const text = tmp.textContent.trim().slice(0, 4000);

  out.classList.remove('hidden');
  out.innerHTML = '<div class="loading-spinner"></div>';
  try {
    const summary = await callDeepSeekSummary(text, apiKey);
    localStorage.setItem(key, summary);
    out.textContent = summary;
  } catch (err) {
    out.textContent = '摘要生成失败：' + err.message;
  }
}

async function callDeepSeekSummary(text, apiKey) {
  const prompt =
`你是中文阅读助手。下面是一章英文小说原文，请用中文概括这一章的主要内容，200字以内，只输出概述本身，不要加任何标题或多余说明。

原文：
"""${text}"""`;

  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0.3,
    }),
  });

  if (resp.status === 401) throw new Error('API Key 无效，请在设置中检查');
  if (resp.status === 429) throw new Error('请求太频繁，请稍后再试');
  if (!resp.ok) throw new Error(`请求失败 (${resp.status})`);

  const data = await resp.json();
  return data.choices[0].message.content.trim();
}

// ─────────────────────────────────────────
// 打卡（功能5）
// ─────────────────────────────────────────
const CHECKIN_GOAL_SECS = 300; // 每天读满 5 分钟

function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getCheckins() {
  try { return JSON.parse(localStorage.getItem('checkin_dates') || '[]'); }
  catch { return []; }
}

function addCheckin(key) {
  const set = getCheckins();
  if (!set.includes(key)) {
    set.push(key);
    localStorage.setItem('checkin_dates', JSON.stringify(set));
  }
}

function startReadingTimer() {
  if (S.readingTimer) return;
  S.readingTimer = setInterval(() => {
    const key = dateKey();
    const secs = parseInt(localStorage.getItem(`read_secs_${key}`) || '0') + 1;
    localStorage.setItem(`read_secs_${key}`, secs);
    if (secs === CHECKIN_GOAL_SECS && !getCheckins().includes(key)) {
      addCheckin(key);
      toast('今日阅读打卡成功！已读满 5 分钟', 3000);
    }
  }, 1000);
}

function stopReadingTimer() {
  if (S.readingTimer) { clearInterval(S.readingTimer); S.readingTimer = null; }
}

function renderCheckinStrip() {
  const el = document.getElementById('checkin-strip');
  if (!el) return;
  const checkins = getCheckins();
  const today = new Date();
  const dow = (today.getDay() + 6) % 7; // 周一=0
  const monday = new Date(today);
  monday.setDate(today.getDate() - dow);
  const labels = ['一', '二', '三', '四', '五', '六', '日'];

  let dots = '';
  let weekCount = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const key = dateKey(d);
    const done = checkins.includes(key);
    if (done) weekCount++;
    const isToday = key === dateKey(today);
    dots += `<div class="checkin-day">
      <span class="checkin-dot${done ? ' done' : ''}${isToday ? ' today' : ''}"></span>
      <span class="checkin-lbl">${labels[i]}</span>
    </div>`;
  }

  // 连续打卡天数
  let streak = 0;
  const cur = new Date(today);
  if (!checkins.includes(dateKey(cur))) cur.setDate(cur.getDate() - 1);
  while (checkins.includes(dateKey(cur))) { streak++; cur.setDate(cur.getDate() - 1); }

  el.innerHTML = `
    <div class="checkin-head">
      <span class="checkin-title">本周已打卡 ${weekCount} 天 · 连续 ${streak} 天</span>
      <button class="checkin-history-btn" id="checkin-history-btn">历史 ›</button>
    </div>
    <div class="checkin-dots">${dots}</div>`;

  document.getElementById('checkin-history-btn').addEventListener('click', () => {
    S.historyMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    renderHistory();
    showView('history');
  });
}

function renderHistory() {
  const wrap = document.getElementById('history-calendar');
  const titleEl = document.getElementById('history-month-title');
  const month = S.historyMonth || new Date();
  const y = month.getFullYear(), m = month.getMonth();
  titleEl.textContent = `${y} 年 ${m + 1} 月`;

  const checkins = getCheckins();
  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7; // 周一=0
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const labels = ['一', '二', '三', '四', '五', '六', '日'];

  let cells = labels.map(l => `<div class="cal-head">${l}</div>`).join('');
  for (let i = 0; i < firstDow; i++) cells += `<div class="cal-cell empty"></div>`;
  let monthCount = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const key = dateKey(new Date(y, m, d));
    const done = checkins.includes(key);
    if (done) monthCount++;
    cells += `<div class="cal-cell${done ? ' done' : ''}">${d}</div>`;
  }
  wrap.innerHTML = cells;
  document.getElementById('history-month-count').textContent = `本月打卡 ${monthCount} 天`;
}

// ─────────────────────────────────────────
// VOCABULARY
// ─────────────────────────────────────────
async function loadVocab() {
  S.vocabulary = await dbGetAll('vocabulary');
  renderVocab();
}

function renderVocab() {
  const list = document.getElementById('vocab-list');
  const countEl = document.getElementById('word-count');
  const quizBtn = document.getElementById('start-quiz-btn');

  countEl.textContent = S.vocabulary.length;
  quizBtn.disabled = S.vocabulary.length < 4;

  if (!S.vocabulary.length) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📝</div>
      <div class="empty-text">阅读时选词翻译后点「保存到单词库」<br>单词会出现在这里</div>
    </div>`;
    return;
  }

  const sorted = [...S.vocabulary].sort((a, b) => b.dateAdded - a.dateAdded);
  list.innerHTML = sorted.map(v => `
    <div class="vocab-item">
      <div class="vocab-item-header">
        <div>
          <span class="vocab-word">${esc(v.word)}</span>
          ${v.baseForm && v.baseForm !== v.word ? `<span class="vocab-base">（${esc(v.baseForm)}）</span>` : ''}
          ${v.phonetic ? `<span class="vocab-phonetic">${esc(v.phonetic)}</span>` : ''}
        </div>
        <button class="vocab-delete" data-id="${v.id}">✕</button>
      </div>
      ${v.defs && v.defs.length > 0
        ? `<div class="vocab-defs">${v.defs.map(d => `<div class="vocab-def">${esc(d)}</div>`).join('')}</div>`
        : v.translation ? `<div class="vocab-translation">${esc(v.translation)}</div>` : ''}
      ${v.meaning ? `<div class="vocab-meaning">${esc(v.meaning)}</div>` : ''}
      ${v.sentence ? `<div class="vocab-sentence">"${highlightInSentence(v.sentence, v.word, v.baseForm)}"</div>` : ''}
    </div>
  `).join('');

  list.querySelectorAll('.vocab-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = +btn.dataset.id;
      await dbDelete('vocabulary', id);
      S.vocabulary = S.vocabulary.filter(v => v.id !== id);
      renderVocab();
    });
  });
}

// ─────────────────────────────────────────
// QUIZ（艾宾浩斯记忆曲线复习）
// ─────────────────────────────────────────
const REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30]; // 答对后下次复习间隔（天）
const DAY_MS = 86400000;

function isDue(v) {
  return (v.nextReview || 0) <= Date.now();
}

async function updateReviewProgress(v, correct) {
  if (correct) {
    v.reviewLevel = (v.reviewLevel || 0) + 1;
    const idx = Math.min(v.reviewLevel - 1, REVIEW_INTERVALS.length - 1);
    v.nextReview = Date.now() + REVIEW_INTERVALS[idx] * DAY_MS;
  } else {
    v.reviewLevel = 0;
    v.nextReview = Date.now() + REVIEW_INTERVALS[0] * DAY_MS;
  }
  v.lastReview = Date.now();
  try { await dbPut('vocabulary', v); } catch (_) {}
}

function startQuiz() {
  if (S.vocabulary.length < 4) { toast('至少需要 4 个单词才能开始练习'); return; }
  const due = S.vocabulary
    .filter(isDue)
    .sort((a, b) => (a.nextReview || 0) - (b.nextReview || 0));
  if (due.length === 0) { toast('今日复习完成，暂时没有需要复习的单词', 3000); return; }
  // 到期最久的优先，每组最多 20 个
  S.quizQuestions = due.slice(0, 20);
  S.quizIndex = 0;
  S.quizCorrect = 0;
  S.quizAnswered = false;
  showView('quiz');
  renderQuestion();
}

function renderQuestion() {
  const q = S.quizQuestions[S.quizIndex];
  document.getElementById('quiz-progress').textContent =
    `${S.quizIndex + 1} / ${S.quizQuestions.length}`;
  document.getElementById('quiz-word').textContent = q.word;
  const phoneticEl = document.getElementById('quiz-phonetic');
  if (phoneticEl) phoneticEl.textContent = q.phonetic || '';
  document.getElementById('quiz-result').classList.add('hidden');
  S.quizAnswered = false;

  // 1 correct + 3 wrong，选项只显示简短中文含义
  const others = shuffle(S.vocabulary.filter(v => v.id !== q.id)).slice(0, 3);
  const choices = shuffle([
    { label: quizLabel(q), correct: true },
    ...others.map(w => ({ label: quizLabel(w), correct: false })),
  ]);

  const box = document.getElementById('quiz-choices');
  box.innerHTML = choices.map((c, i) =>
    `<button class="choice-btn" data-idx="${i}" data-correct="${c.correct}">${esc(c.label)}</button>`
  ).join('');

  box.querySelectorAll('.choice-btn').forEach(btn => {
    btn.addEventListener('click', () => handleAnswer(btn, q));
  });
}

function handleAnswer(btn, q) {
  if (S.quizAnswered) return;
  S.quizAnswered = true;

  const correct = btn.dataset.correct === 'true';
  if (correct) S.quizCorrect++;
  updateReviewProgress(q, correct);

  document.querySelectorAll('.choice-btn').forEach(b => {
    b.disabled = true;
    if (b.dataset.correct === 'true') b.classList.add('correct');
  });
  if (!correct) btn.classList.add('wrong');

  const result = document.getElementById('quiz-result');
  const icon = document.getElementById('result-icon');
  const msg = document.getElementById('result-message');
  const ans = document.getElementById('correct-answer');
  const sent = document.getElementById('original-sentence');

  if (correct) {
    icon.textContent = '✓';
    msg.textContent = '回答正确！';
    msg.className = 'result-message correct';
    ans.classList.add('hidden');
  } else {
    icon.textContent = '✗';
    msg.textContent = '答错了';
    msg.className = 'result-message wrong';
    ans.textContent = `正确答案：${q.translation}`;
    ans.classList.remove('hidden');
  }

  sent.textContent = q.sentence ? `"${q.sentence}"` : '';
  sent.style.display = q.sentence ? 'block' : 'none';
  result.classList.remove('hidden');

  const isLast = S.quizIndex === S.quizQuestions.length - 1;
  const nextBtn = document.getElementById('next-question-btn');
  if (!isLast) {
    nextBtn.textContent = '下一题';
    nextBtn.onclick = () => { S.quizIndex++; renderQuestion(); };
  } else {
    // 本组已答完的词复习时间已顺延，重新统计还有没有到期词
    const remaining = S.vocabulary.filter(isDue).length;
    if (remaining > 0) {
      nextBtn.textContent = '继续复习下一组';
      nextBtn.onclick = () => startQuiz();
    } else {
      nextBtn.textContent = '完成';
      nextBtn.onclick = () => {
        showView('vocab');
        toast(`复习完成！本组答对 ${S.quizCorrect} / ${S.quizQuestions.length} 题`, 3000, true);
      };
    }
  }
}

// ─────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────
function initSettings() {
  const input = document.getElementById('api-key-input');
  const saved = localStorage.getItem('deepseek_api_key') || '';
  if (saved) input.placeholder = '已设置（点此修改）';

  document.getElementById('save-api-key-btn').addEventListener('click', () => {
    const k = input.value.trim();
    if (!k) { toast('请输入 API Key'); return; }
    localStorage.setItem('deepseek_api_key', k);
    input.value = '';
    input.placeholder = '已设置（点此修改）';
    toast('API Key 已保存');
  });

  document.getElementById('font-size-display').textContent = S.fontSize + 'px';

  document.getElementById('font-increase').addEventListener('click', () => {
    S.fontSize = Math.min(30, S.fontSize + 2);
    updateFontSize();
  });
  document.getElementById('font-decrease').addEventListener('click', () => {
    S.fontSize = Math.max(14, S.fontSize - 2);
    updateFontSize();
  });

  // 界面字号
  const savedUiSize = localStorage.getItem('ui_size') || '0';
  applyUiSize(savedUiSize);
  document.querySelectorAll('.ui-size-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === savedUiSize);
    btn.addEventListener('click', () => {
      applyUiSize(btn.dataset.size);
      localStorage.setItem('ui_size', btn.dataset.size);
      document.querySelectorAll('.ui-size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.getElementById('clear-vocab-btn').addEventListener('click', async () => {
    if (!confirm('确定清空所有单词？此操作不可撤销。')) return;
    await dbClear('vocabulary');
    S.vocabulary = [];
    renderVocab();
    toast('单词库已清空');
  });

  // 背景图
  const bgFileInput = document.getElementById('bg-file-input');
  const bgPreview = document.getElementById('bg-preview');
  const bgOverlayRange = document.getElementById('bg-overlay-range');
  const bgOverlayVal = document.getElementById('bg-overlay-val');
  const bgOverlayPreview = document.getElementById('bg-overlay-preview');
  const bgPlaceholder = document.getElementById('bg-placeholder');

  const savedBg = localStorage.getItem('reader_bg');
  const savedOverlay = localStorage.getItem('reader_bg_overlay') || '50';

  bgOverlayRange.value = savedOverlay;
  bgOverlayVal.textContent = savedOverlay + '%';
  bgOverlayPreview.style.opacity = parseInt(savedOverlay) / 100;

  if (savedBg) {
    bgPreview.src = savedBg;
    bgPreview.classList.add('visible');
    bgPlaceholder.style.display = 'none';
  }

  bgFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const dataUrl = await resizeImage(file);
    localStorage.setItem('reader_bg', dataUrl);
    bgPreview.src = dataUrl;
    bgPreview.classList.add('visible');
    bgPlaceholder.style.display = 'none';
    applyReaderBg();
    toast('背景图已更新');
  });

  bgOverlayRange.addEventListener('input', () => {
    const v = bgOverlayRange.value;
    bgOverlayVal.textContent = v + '%';
    bgOverlayPreview.style.opacity = parseInt(v) / 100;
    localStorage.setItem('reader_bg_overlay', v);
    applyReaderBg();
  });

  document.getElementById('clear-bg-btn').addEventListener('click', () => {
    localStorage.removeItem('reader_bg');
    bgPreview.src = '';
    bgPreview.classList.remove('visible');
    bgPlaceholder.style.display = '';
    applyReaderBg();
    toast('背景图已清除');
  });
}

function applyUiSize(size) {
  document.documentElement.style.setProperty('--ui-boost', size + 'px');
}

function resizeImage(file) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const maxW = 1200;
      let w = img.width, h = img.height;
      if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.src = url;
  });
}

function applyReaderBg() {
  const dataUrl = localStorage.getItem('reader_bg');
  const opacity = parseInt(localStorage.getItem('reader_bg_overlay') || '50') / 100;
  const rc = document.getElementById('reader-content');
  if (dataUrl) {
    const ov = `rgba(255,255,255,${opacity})`;
    rc.style.background = `linear-gradient(${ov}, ${ov}), url(${dataUrl}) center/cover no-repeat`;
  } else {
    rc.style.background = 'rgba(255,255,255,0.92)';
  }
}

function updateFontSize() {
  localStorage.setItem('font_size', S.fontSize);
  document.getElementById('font-size-display').textContent = S.fontSize + 'px';
  document.getElementById('reader-content').style.fontSize = S.fontSize + 'px';
}

// ─────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlightInSentence(sentence, word, baseForm) {
  const targets = [word, baseForm].filter(Boolean);
  for (const t of targets) {
    const idx = sentence.toLowerCase().indexOf(t.toLowerCase());
    if (idx !== -1) {
      return esc(sentence.slice(0, idx)) +
        `<u>${esc(sentence.slice(idx, idx + t.length))}</u>` +
        esc(sentence.slice(idx + t.length));
    }
  }
  return esc(sentence);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─────────────────────────────────────────
// EVENT BINDING
// ─────────────────────────────────────────
function bindEvents() {
  // bottom nav
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.view === 'vocab') loadVocab();
      showView(btn.dataset.view);
    });
  });

  // settings
  document.getElementById('settings-btn').addEventListener('click', () => showView('settings'));
  document.getElementById('settings-back-btn').addEventListener('click', () => showView('shelf'));

  // reader back
  document.getElementById('back-btn').addEventListener('click', () => {
    document.getElementById('translation-popup').classList.add('hidden');
    hideTranslateBtn();
    showView('shelf');
  });

  // theme toggle
  document.getElementById('theme-btn').addEventListener('click', () => {
    S.darkMode = !S.darkMode;
    document.body.classList.toggle('dark', S.darkMode);
    localStorage.setItem('dark_mode', S.darkMode);
    document.getElementById('theme-btn').textContent = S.darkMode ? '🌙' : '☀';
  });

  // chapter nav
  document.getElementById('prev-chapter').addEventListener('click', () => {
    if (S.currentChapter > 0) { S.currentChapter--; renderChapter(); }
  });
  document.getElementById('next-chapter').addEventListener('click', () => {
    if (S.currentBook && S.currentChapter < S.currentBook.chapters.length - 1) {
      S.currentChapter++; renderChapter();
    }
  });

  // import
  document.getElementById('file-input').addEventListener('change', async (e) => {
    if (e.target.files[0]) { await importBook(e.target.files[0]); e.target.value = ''; }
  });

  // translation popup
  document.getElementById('popup-overlay').addEventListener('click', () => {
    document.getElementById('translation-popup').classList.add('hidden');
  });
  document.getElementById('close-popup-btn').addEventListener('click', () => {
    document.getElementById('translation-popup').classList.add('hidden');
  });
  document.getElementById('save-word-btn').addEventListener('click', saveWord);

  // lookup 查词
  document.getElementById('lookup-btn').addEventListener('click', doLookup);
  document.getElementById('lookup-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doLookup(); }
  });

  // quiz
  document.getElementById('start-quiz-btn').addEventListener('click', startQuiz);
  document.getElementById('quit-quiz-btn').addEventListener('click', () => showView('vocab'));

  // 打卡历史
  document.getElementById('history-back-btn').addEventListener('click', () => showView('shelf'));
  document.getElementById('history-prev-btn').addEventListener('click', () => {
    S.historyMonth.setMonth(S.historyMonth.getMonth() - 1);
    renderHistory();
  });
  document.getElementById('history-next-btn').addEventListener('click', () => {
    S.historyMonth.setMonth(S.historyMonth.getMonth() + 1);
    renderHistory();
  });

  // 锁屏/切到后台时暂停打卡计时，避免偷算时间
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopReadingTimer();
    else if (S.view === 'reader') startReadingTimer();
  });

  // selection
  setupSelection();
}

// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────
async function init() {
  if (S.darkMode) {
    document.body.classList.add('dark');
    document.getElementById('theme-btn').textContent = '🌙';
  }
  document.getElementById('reader-content').style.fontSize = S.fontSize + 'px';
  applyUiSize(localStorage.getItem('ui_size') || '0');

  try {
    await initDB();
    await Promise.all([loadShelf(), loadVocab()]);
    bindEvents();
    initSettings();
    applyReaderBg();
    if (!localStorage.getItem('deepseek_api_key')) {
      toast('首次使用请先进「设置」输入 API Key', 3500);
    }
  } catch (err) {
    toast('初始化失败：' + err.message, 5000);
    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', init);
