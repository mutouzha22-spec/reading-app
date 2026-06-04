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
  quizQuestions: [],
  quizIndex: 0,
  quizCorrect: 0,
  quizAnswered: false,
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
  nav.style.display = ['shelf', 'vocab'].includes(name) ? 'flex' : 'none';
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  S.view = name;
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
  const list = document.getElementById('book-list');
  if (!S.books.length) {
    list.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">📚</div>
      <div class="empty-text">还没有书籍<br>点击下方导入 EPUB 开始阅读</div>
    </div>`;
    return;
  }
  list.innerHTML = S.books.map(b => `
    <div class="book-card" data-id="${b.id}">
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
  renderChapter();
  showView('reader');
}

function renderChapter() {
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
  rc.scrollTop = 0;

  localStorage.setItem(`pos_${book.id}`, S.currentChapter);
  hideTranslateBtn();
}

// ─────────────────────────────────────────
// TEXT SELECTION + TRANSLATION
// ─────────────────────────────────────────
function setupSelection() {
  const btn = document.getElementById('translate-btn');

  document.addEventListener('selectionchange', () => {
    if (S.view !== 'reader') return;
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    if (text.length < 1 || text.length > 600) {
      // wait briefly before hiding (user might be tapping our button)
      setTimeout(() => {
        if (!window.getSelection().toString().trim()) hideTranslateBtn();
      }, 180);
      return;
    }
    try {
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      // walk up to paragraph-level container
      let node = range.commonAncestorContainer;
      let para = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const rc = document.getElementById('reader-content');
      while (para && para !== rc && !['P','DIV','SECTION','BLOCKQUOTE','LI'].includes(para.tagName)) {
        para = para.parentElement;
      }
      const context = para ? para.textContent.trim() : text;
      const sentence = extractSentence(context, text);

      S.savedSelText = { text, context, sentence };

      // position button above selection
      const top = Math.max(rect.top - 48, 60);
      const left = Math.min(Math.max(rect.left + rect.width / 2 - 36, 8), window.innerWidth - 90);
      btn.style.top = top + 'px';
      btn.style.left = left + 'px';
      btn.classList.remove('hidden');
    } catch (_) { /* ignore */ }
  });

  // prevent touchstart from clearing iOS selection
  btn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  btn.addEventListener('touchend', (e) => {
    e.preventDefault();
    triggerTranslation();
  });
  btn.addEventListener('click', triggerTranslation); // desktop fallback

  // hide button on reader scroll
  document.getElementById('reader-content').addEventListener('scroll', hideTranslateBtn);
}

function hideTranslateBtn() {
  document.getElementById('translate-btn').classList.add('hidden');
}

function extractSentence(fullText, target) {
  const sentences = fullText.match(/[^.!?…]+[.!?…]+/g) || [];
  for (const s of sentences) {
    if (s.includes(target)) return s.trim();
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
  S.pendingTranslation = null;
  popup.classList.remove('hidden');

  const apiKey = localStorage.getItem('deepseek_api_key');
  if (!apiKey) {
    bodyEl.textContent = '请先到「设置」页面输入 DeepSeek API Key';
    return;
  }

  try {
    const raw = await callDeepSeek(sel.text, sel.context, apiKey);
    const { translation, meaning } = parseResponse(raw);
    S.pendingTranslation = { word: sel.text, translation, meaning, sentence: sel.sentence };
    bodyEl.innerHTML = `
      <div class="translation-line">${esc(translation)}</div>
      ${meaning ? `<div class="meaning-line">${esc(meaning)}</div>` : ''}
    `;
    saveBtn.style.display = 'block';
  } catch (err) {
    bodyEl.textContent = '翻译失败：' + err.message;
  }
}

async function callDeepSeek(word, context, apiKey) {
  const prompt =
`你是英文阅读助手。用户在阅读英文小说时选中了一段文字，请结合上下文翻译，给出准确的中文含义。

书中原文（上下文）：
"${context.slice(0, 500)}"

用户选中的内容：「${word}」

要求：结合上下文理解词义，而非孤立翻译。单词给出此语境下的具体含义；短语或句子给出流畅中文翻译。

严格按以下格式回复，不要加任何额外内容：
翻译：[中文翻译]
释义：[在此处的含义，一句话以内]`;

  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 160,
      temperature: 0.2,
    }),
  });

  if (resp.status === 401) throw new Error('API Key 无效，请在设置中检查');
  if (resp.status === 429) throw new Error('请求太频繁，请稍后再试');
  if (!resp.ok) throw new Error(`请求失败 (${resp.status})`);

  const data = await resp.json();
  return data.choices[0].message.content.trim();
}

function parseResponse(text) {
  let translation = '', meaning = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('翻译：')) translation = line.slice(3).trim();
    else if (line.startsWith('释义：')) meaning = line.slice(3).trim();
  }
  if (!translation) translation = text.split('\n')[0].replace(/^翻译[：:]\s*/, '').trim() || text;
  return { translation, meaning };
}

async function saveWord() {
  if (!S.pendingTranslation) return;
  const pt = S.pendingTranslation;
  const dup = S.vocabulary.find(v => v.word.toLowerCase() === pt.word.toLowerCase());
  if (dup) { toast('这个词已经在单词库里了'); return; }

  const entry = {
    word: pt.word,
    translation: pt.translation,
    meaning: pt.meaning,
    sentence: pt.sentence,
    bookTitle: S.currentBook ? S.currentBook.title : '',
    dateAdded: Date.now(),
  };
  const id = await dbAdd('vocabulary', entry);
  entry.id = id;
  S.vocabulary.push(entry);
  document.getElementById('translation-popup').classList.add('hidden');
  toast('已保存到单词库');
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
        <span class="vocab-word">${esc(v.word)}</span>
        <button class="vocab-delete" data-id="${v.id}">✕</button>
      </div>
      <div class="vocab-translation">${esc(v.translation)}</div>
      ${v.meaning ? `<div class="vocab-meaning">${esc(v.meaning)}</div>` : ''}
      ${v.sentence ? `<div class="vocab-sentence">"${esc(v.sentence)}"</div>` : ''}
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
// QUIZ
// ─────────────────────────────────────────
function startQuiz() {
  if (S.vocabulary.length < 4) { toast('至少需要 4 个单词才能开始练习'); return; }
  const pool = shuffle([...S.vocabulary]);
  S.quizQuestions = pool.slice(0, Math.min(20, pool.length));
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
  document.getElementById('quiz-result').classList.add('hidden');
  S.quizAnswered = false;

  // 1 correct + 3 wrong
  const others = shuffle(S.vocabulary.filter(v => v.id !== q.id)).slice(0, 3);
  const choices = shuffle([
    { label: q.translation, correct: true },
    ...others.map(w => ({ label: w.translation, correct: false })),
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
  nextBtn.textContent = isLast ? '完成练习' : '下一题';
  nextBtn.onclick = () => {
    if (isLast) {
      showView('vocab');
      toast(`练习完成！答对 ${S.quizCorrect} / ${S.quizQuestions.length} 题`, 3000, true);
    } else {
      S.quizIndex++;
      renderQuestion();
    }
  };
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

  document.getElementById('clear-vocab-btn').addEventListener('click', async () => {
    if (!confirm('确定清空所有单词？此操作不可撤销。')) return;
    await dbClear('vocabulary');
    S.vocabulary = [];
    renderVocab();
    toast('单词库已清空');
  });
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

  // quiz
  document.getElementById('start-quiz-btn').addEventListener('click', startQuiz);
  document.getElementById('quit-quiz-btn').addEventListener('click', () => showView('vocab'));

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

  try {
    await initDB();
    await Promise.all([loadShelf(), loadVocab()]);
    bindEvents();
    initSettings();
    if (!localStorage.getItem('deepseek_api_key')) {
      toast('首次使用请先进「设置」输入 API Key', 3500);
    }
  } catch (err) {
    toast('初始化失败：' + err.message, 5000);
    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', init);
