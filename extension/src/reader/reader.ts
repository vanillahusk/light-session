import browser from '../shared/browser-polyfill';
import { highlightCode } from './syntax-highlight';
import {
  isReaderSnapshot,
  readerPositionKey,
  readerSnapshotKey,
  recordsToReaderUnits,
  type ReaderConversationSnapshot,
  type ReaderUnit,
} from '../shared/reader-data';

const SAVE_DELAY_MS = 1200;

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing reader element: ${id}`);
  return element as T;
}

function cleanLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function formatDate(timestamp: number | null): string {
  if (!timestamp) return '';
  return new Date(timestamp * 1000).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function appendInline(parent: HTMLElement, text: string): void {
  const tokenPattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|==[^=\n]+==|\*[^*\n]+\*|_[^_\n]+_|!\[[^\]\n]*\]\([^\s)]+\)|\[[^\]\n]+\]\([^\s)]+\)|\[\[[^\]\n]+\]\]|https?:\/\/[^\s<]+)/g;
  let cursor = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const index = match.index;
    const token = match[0];
    if (index > cursor) parent.append(document.createTextNode(text.slice(cursor, index)));
    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      const strong = document.createElement('strong');
      appendInline(strong, token.slice(2, -2));
      parent.append(strong);
    } else if (token.startsWith('~~')) {
      const deleted = document.createElement('del');
      appendInline(deleted, token.slice(2, -2));
      parent.append(deleted);
    } else if (token.startsWith('==')) {
      const highlight = document.createElement('mark');
      appendInline(highlight, token.slice(2, -2));
      parent.append(highlight);
    } else if (token.startsWith('*') || token.startsWith('_')) {
      const emphasis = document.createElement('em');
      appendInline(emphasis, token.slice(1, -1));
      parent.append(emphasis);
    } else if (token.startsWith('[[')) {
      const wiki = document.createElement('span');
      wiki.className = 'internal-link';
      const value = token.slice(2, -2);
      const parts = value.split('|');
      wiki.textContent = parts[parts.length - 1] ?? value;
      wiki.title = 'Obsidian 内部链接（此阅读器中不可跳转）';
      parent.append(wiki);
    } else if (/^https?:\/\//i.test(token)) {
      const href = token.replace(/[.,;:!?'"。；：！？，]+$/u, '');
      const link = document.createElement('a');
      link.textContent = href;
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      parent.append(link);
      if (href.length < token.length)
        parent.append(document.createTextNode(token.slice(href.length)));
    } else {
      const image = token.startsWith('!');
      const linkMatch = token.match(/^!?\[([^\]]*)\]\(([^)]+)\)$/);
      const href = linkMatch?.[2] ?? '';
      if (linkMatch && /^(https?:|mailto:)/i.test(href)) {
        const link = document.createElement('a');
        link.className = image ? 'image-link' : '';
        link.textContent = image ? `🖼 ${linkMatch[1] || '图片'}` : (linkMatch[1] ?? href);
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        parent.append(link);
      } else {
        parent.append(document.createTextNode(token));
      }
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

function isBlockStart(line: string): boolean {
  return /^(#{1,6}\s+|```|~~~|>\s?|[-*+]\s+|\d+[.)]\s+|(?:---+|___+|\*\*\*+)$)/.test(line.trim());
}

function tableCells(line: string): string[] {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\\' && value[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (value[index] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += value[index];
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isTableSeparator(line: string): boolean {
  return tableCells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function renderReaderMarkdown(text: string, target: HTMLElement): void {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^(```+|~~~+)\s*([^\s`]*)/);
    if (fence) {
      const fenceMarker = fence[1] ?? '```';
      const language = fence[2] ?? '';
      const codeLines: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !(lines[index] ?? '').trim().startsWith(fenceMarker[0]?.repeat(fenceMarker.length) ?? '```')
      ) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      const codeText = codeLines.join('\n');
      const header = document.createElement('div');
      header.className = 'code-head';
      const label = document.createElement('span');
      label.textContent = language || '代码';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'small-action';
      copy.textContent = '复制';
      copy.addEventListener('click', () => void copyText(codeText, copy));
      header.append(label, copy);
      wrapper.append(header);
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      highlightCode(codeText, language, code);
      pre.append(code);
      wrapper.append(pre);
      target.append(wrapper);
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?$/);
    if (heading) {
      const element = document.createElement(`h${heading[1]?.length ?? 1}`);
      appendInline(element, heading[2] ?? '');
      target.append(element);
      index += 1;
      continue;
    }

    if (/^(?:---+|___+|\*\*\*+)$/.test(trimmed)) {
      target.append(document.createElement('hr'));
      index += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('>')) {
        quoteLines.push((lines[index] ?? '').trim().replace(/^>\s?/, ''));
        index += 1;
      }
      const callout = quoteLines[0]?.match(/^\[!([A-Za-z-]+)\][+-]?\s*(.*)$/);
      if (callout) {
        const type = (callout[1] ?? 'note').toLocaleLowerCase();
        const box = document.createElement('aside');
        box.className = `callout callout-${type}`;
        const title = document.createElement('div');
        title.className = 'callout-title';
        title.textContent = callout[2]?.trim() || type.toLocaleUpperCase();
        const body = document.createElement('div');
        body.className = 'callout-body';
        renderReaderMarkdown(quoteLines.slice(1).join('\n'), body);
        box.append(title, body);
        target.append(box);
      } else {
        const quote = document.createElement('blockquote');
        renderReaderMarkdown(quoteLines.join('\n'), quote);
        target.append(quote);
      }
      continue;
    }

    if (
      trimmed.includes('|') &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1] ?? '')
    ) {
      const headers = tableCells(trimmed);
      const alignments = tableCells(lines[index + 1] ?? '').map((cell) =>
        cell.startsWith(':') && cell.endsWith(':')
          ? 'center'
          : cell.endsWith(':')
            ? 'right'
            : 'left'
      );
      const wrapper = document.createElement('div');
      wrapper.className = 'table-wrap';
      const table = document.createElement('table');
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      headers.forEach((value, column) => {
        const cell = document.createElement('th');
        cell.style.textAlign = alignments[column] ?? 'left';
        appendInline(cell, value);
        headRow.append(cell);
      });
      head.append(headRow);
      table.append(head);
      const body = document.createElement('tbody');
      index += 2;
      while (index < lines.length && (lines[index] ?? '').trim().includes('|')) {
        const row = document.createElement('tr');
        tableCells(lines[index] ?? '').forEach((value, column) => {
          const cell = document.createElement('td');
          cell.style.textAlign = alignments[column] ?? 'left';
          appendInline(cell, value);
          row.append(cell);
        });
        body.append(row);
        index += 1;
      }
      table.append(body);
      wrapper.append(table);
      target.append(wrapper);
      continue;
    }

    const listMatch = trimmed.match(/^([-*+]|\d+[.)])\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+[.)]/.test(listMatch[1] ?? '');
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const itemMatch = (lines[index] ?? '').trim().match(/^([-*+]|\d+[.)])\s+(.+)$/);
        if (!itemMatch || /\d+[.)]/.test(itemMatch[1] ?? '') !== ordered) break;
        const item = document.createElement('li');
        const task = !ordered ? (itemMatch[2] ?? '').match(/^\[([ xX])\]\s+(.*)$/) : null;
        if (task) {
          item.className = 'task-item';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.disabled = true;
          checkbox.checked = task[1]?.toLocaleLowerCase() === 'x';
          item.append(checkbox);
          const value = document.createElement('span');
          appendInline(value, task[2] ?? '');
          item.append(value);
        } else {
          appendInline(item, itemMatch[2] ?? '');
        }
        list.append(item);
        index += 1;
      }
      target.append(list);
      continue;
    }

    const paragraphLines = [trimmed];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? '';
      if (!next.trim() || isBlockStart(next)) break;
      paragraphLines.push(next.trim());
      index += 1;
    }
    const paragraph = document.createElement('p');
    appendInline(paragraph, paragraphLines.join('\n'));
    target.append(paragraph);
  }
}

async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
  const original = button.textContent ?? '复制';
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = '已复制';
  } catch {
    button.textContent = '复制失败';
  }
  window.setTimeout(() => {
    button.textContent = original;
  }, 1400);
}

function unitMarkdown(unit: ReaderUnit): string {
  return [`# ${unit.question}`, ...unit.answers.map((answer) => `## ChatGPT\n\n${answer}`)].join(
    '\n\n'
  );
}

function exportConversation(snapshot: ReaderConversationSnapshot, units: ReaderUnit[]): void {
  const markdown = [`# ${snapshot.title}`, ...units.map(unitMarkdown)].join('\n\n---\n\n');
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${snapshot.title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'ChatGPT 对话'}.md`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function messageArticle(
  role: 'user' | 'assistant',
  text: string,
  turnIndex: number,
  timestamp: number | null,
  copyWholeTurn?: () => void
): HTMLElement {
  const article = document.createElement('article');
  article.className = `message ${role}`;
  article.dataset.searchText = text.toLocaleLowerCase();
  const head = document.createElement('div');
  head.className = 'message-head';
  const author = document.createElement('span');
  author.className = 'author';
  author.textContent = role === 'user' ? '你' : 'ChatGPT';
  head.append(author);
  const date = formatDate(timestamp);
  if (date) {
    const when = document.createElement('span');
    when.className = 'message-date';
    when.textContent = date;
    head.append(when);
  }
  if (role === 'user') {
    const number = document.createElement('span');
    number.className = 'turn-number';
    number.textContent = `第 ${turnIndex + 1} 轮`;
    head.append(number);
  }
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'small-action';
  copy.textContent = '复制';
  copy.addEventListener('click', () => void copyText(text, copy));
  actions.append(copy);
  if (copyWholeTurn) {
    const copyTurn = document.createElement('button');
    copyTurn.type = 'button';
    copyTurn.className = 'small-action';
    copyTurn.textContent = '复制本轮';
    copyTurn.addEventListener('click', copyWholeTurn);
    actions.append(copyTurn);
  }
  head.append(actions);
  const body = document.createElement('div');
  body.className = 'body';
  renderReaderMarkdown(text, body);
  article.append(head, body);
  return article;
}

async function initialize(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const conversationId = params.get('conversation');
  const targetId = params.get('target');
  const status = requiredElement<HTMLElement>('reader-status');
  if (!conversationId) {
    status.textContent = '缺少对话标识，无法打开阅读器。';
    return;
  }

  const snapshotKey = readerSnapshotKey(conversationId);
  const stored = (await browser.storage.local.get(snapshotKey)) as Record<string, unknown>;
  const snapshot = stored[snapshotKey];
  if (!isReaderSnapshot(snapshot)) {
    status.textContent = '没有找到阅读内容，请返回 ChatGPT 后重新点击目录。';
    return;
  }
  const units = recordsToReaderUnits(snapshot.records);
  if (units.length === 0) {
    status.textContent = '当前对话中没有可阅读的问答。';
    return;
  }

  document.title = `${snapshot.title} · LightSession`;
  requiredElement<HTMLElement>('conversation-title').textContent = snapshot.title;
  requiredElement<HTMLElement>('conversation-status').textContent =
    `${units.length} 轮 · ${snapshot.records.length} 条消息`;
  requiredElement<HTMLElement>('turn-count').textContent = String(units.length);
  requiredElement<HTMLAnchorElement>('chat-link').href =
    `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`;
  requiredElement<HTMLButtonElement>('export-button').addEventListener('click', () =>
    exportConversation(snapshot, units)
  );
  requiredElement<HTMLButtonElement>('outline-toggle').addEventListener('click', () =>
    document.body.classList.toggle('outline-open')
  );

  const outline = requiredElement<HTMLElement>('outline-list');
  const content = requiredElement<HTMLElement>('reader-content');
  const turnElements = new Map<string, HTMLElement>();
  const outlineButtons = new Map<string, HTMLButtonElement>();

  const scrollToTurn = (id: string, smooth = true): void => {
    document.body.classList.remove('outline-open');
    turnElements.get(id)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  };

  units.forEach((unit, index) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outline-item';
    button.title = cleanLine(unit.question);
    const line = document.createElement('span');
    line.className = 'outline-line';
    const number = document.createElement('span');
    number.className = 'outline-number';
    number.textContent = String(index + 1);
    line.append(number, document.createTextNode(cleanLine(unit.question) || '未命名提问'));
    button.append(line);
    button.addEventListener('click', () => scrollToTurn(unit.id));
    item.append(button);
    outline.append(item);
    outlineButtons.set(unit.id, button);

    const turn = document.createElement('section');
    turn.className = 'turn';
    turn.dataset.messageId = unit.id;
    const turnText = `问题：\n${unit.question}\n\n回答：\n${unit.answers.join('\n\n')}`;
    turn.append(
      messageArticle('user', unit.question, index, unit.questionTime, () => {
        const copyButton = turn.querySelector<HTMLButtonElement>(
          '.message.user .small-action:last-child'
        );
        if (copyButton) void copyText(turnText, copyButton);
      })
    );
    unit.answers.forEach((answer, answerIndex) => {
      turn.append(
        messageArticle('assistant', answer, index, unit.answerTimes[answerIndex] ?? null)
      );
    });
    content.append(turn);
    turnElements.set(unit.id, turn);
  });

  requiredElement<HTMLElement>('app').hidden = false;
  status.hidden = true;

  let activeId: string | null = null;
  let saveTimer: number | null = null;
  let scrollFrame: number | null = null;
  const positionKey = readerPositionKey(conversationId);
  const setActive = (id: string): void => {
    if (activeId === id) return;
    activeId = id;
    for (const [turnId, turn] of turnElements) turn.classList.toggle('is-active', turnId === id);
    for (const [turnId, button] of outlineButtons) {
      const selected = turnId === id;
      button.classList.toggle('is-active', selected);
      if (selected) button.scrollIntoView({ block: 'nearest' });
    }
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void browser.storage.local.get(positionKey).then((value) => {
        const current = value as Record<string, unknown>;
        if (current[positionKey] !== id) void browser.storage.local.set({ [positionKey]: id });
      });
    }, SAVE_DELAY_MS);
  };

  const detectActive = (): void => {
    scrollFrame = null;
    let current = units[0];
    for (const unit of units) {
      const turn = turnElements.get(unit.id);
      if (turn && turn.getBoundingClientRect().top <= 76) current = unit;
      else break;
    }
    if (current) setActive(current.id);
  };
  window.addEventListener(
    'scroll',
    () => {
      if (scrollFrame === null) scrollFrame = window.requestAnimationFrame(detectActive);
    },
    { passive: true }
  );

  const findInput = requiredElement<HTMLInputElement>('find-input');
  const findCount = requiredElement<HTMLElement>('find-count');
  const findPrevious = requiredElement<HTMLButtonElement>('find-prev');
  const findNext = requiredElement<HTMLButtonElement>('find-next');
  let matches: HTMLElement[] = [];
  let matchIndex = -1;
  const showMatch = (offset: number): void => {
    if (matches.length === 0) return;
    matches[matchIndex]?.classList.remove('search-match');
    matchIndex = (matchIndex + offset + matches.length) % matches.length;
    const match = matches[matchIndex];
    match?.classList.add('search-match');
    match?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    findCount.textContent = `${matchIndex + 1}/${matches.length}`;
  };
  const refreshFind = (): void => {
    for (const match of matches) match.classList.remove('search-match');
    const query = findInput.value.trim().toLocaleLowerCase();
    matches = query
      ? Array.from(content.querySelectorAll<HTMLElement>('.message')).filter((message) =>
          (message.dataset.searchText ?? '').includes(query)
        )
      : [];
    matchIndex = -1;
    findPrevious.disabled = matches.length === 0;
    findNext.disabled = matches.length === 0;
    findCount.textContent = matches.length > 0 ? `0/${matches.length}` : '';
  };
  findInput.addEventListener('input', refreshFind);
  findPrevious.addEventListener('click', () => showMatch(-1));
  findNext.addEventListener('click', () => showMatch(1));
  refreshFind();

  let initialId = targetId && turnElements.has(targetId) ? targetId : null;
  if (!initialId) {
    const position = (await browser.storage.local.get(positionKey)) as Record<string, unknown>;
    const saved = position[positionKey];
    if (typeof saved === 'string' && turnElements.has(saved)) initialId = saved;
  }
  initialId ??= units[0]?.id ?? null;
  if (initialId) {
    const resolvedId = initialId;
    setActive(resolvedId);
    window.setTimeout(() => scrollToTurn(resolvedId, false), 0);
  }
}

void initialize().catch((error: unknown) => {
  const status = document.getElementById('reader-status');
  if (status) {
    status.textContent = `阅读器打开失败：${error instanceof Error ? error.message : String(error)}`;
  }
});

