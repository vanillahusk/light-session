import browser from '../shared/browser-polyfill';
import { extractConversationPageId } from '../shared/url';
import { sendMessageWithTimeout } from '../shared/messages';
import type { OpenReaderResponse, SyncDesktopResponse } from '../shared/types';
import {
  readerPositionKey,
  readerRecordsSignature,
  readerSnapshotKey,
  type ReaderConversationSnapshot,
  type ReaderMessageRecord,
  type ReaderMessageRole,
} from '../shared/reader-data';

const SAVE_DELAY_MS = 1200;
const HEADER_FALLBACK_PX = 72;

interface ReaderTurn {
  id: string;
  question: HTMLElement | null;
  answers: HTMLElement[];
  host: HTMLElement | null;
  title: string;
  questionText: string;
  answerTexts: string[];
}

type MessageRole = ReaderMessageRole;

interface MessageCandidate {
  role: MessageRole;
  content: HTMLElement;
  host: HTMLElement;
}

export interface ReaderSidebarController {
  enable(): void;
  refreshForNavigation(): void;
  teardown(): void;
}

function normalizeText(element: HTMLElement): string {
  return element.innerText.replace(/\s+/g, ' ').trim();
}

function createTurnId(question: HTMLElement, host: HTMLElement, index: number): string {
  const messageId =
    host.dataset.messageId ??
    host.dataset.turnIdContainer ??
    host.dataset.turnId ??
    question.closest<HTMLElement>('[data-message-id]')?.dataset.messageId ??
    question.closest<HTMLElement>('[data-turn-id-container]')?.dataset.turnIdContainer;
  if (messageId) return messageId;

  const articleTestId =
    host.dataset.testid ?? question.closest<HTMLElement>('[data-testid]')?.dataset.testid;
  if (articleTestId) return articleTestId;

  const text = normalizeText(question);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `turn-${index}-${(hash >>> 0).toString(36)}`;
}

function closestTurnHost(element: HTMLElement): HTMLElement {
  return (
    element.closest<HTMLElement>(
      '[data-message-id], [data-turn-id-container], [data-turn-id], [data-testid^="conversation-turn"], article'
    ) ?? element
  );
}

function contentForRole(host: HTMLElement, role: MessageRole): HTMLElement {
  if (role === 'user') {
    return (
      host.querySelector<HTMLElement>('.user-message-bubble-color .whitespace-pre-wrap') ??
      host.querySelector<HTMLElement>('.user-message-bubble-color') ??
      host
    );
  }

  return (
    host.querySelector<HTMLElement>('.markdown.prose, .markdown-new-styling, .markdown') ?? host
  );
}

function collectMessageCandidates(root: ParentNode): MessageCandidate[] {
  const scope = root.querySelector<HTMLElement>('main') ?? root;
  const candidates: MessageCandidate[] = [];
  const seenHosts = new Set<HTMLElement>();

  const add = (role: MessageRole, element: HTMLElement): void => {
    const host = closestTurnHost(element);
    if (seenHosts.has(host)) return;
    seenHosts.add(host);
    candidates.push({ role, host, content: contentForRole(host, role) });
  };

  const explicitNodes = Array.from(
    scope.querySelectorAll<HTMLElement>(
      '[data-message-author-role="user"], [data-message-author-role="assistant"], [data-turn="user"], [data-turn="assistant"]'
    )
  );
  for (const node of explicitNodes) {
    const role = node.dataset.messageAuthorRole ?? node.dataset.turn;
    if (role === 'user' || role === 'assistant') add(role, node);
  }

  for (const bubble of Array.from(
    scope.querySelectorAll<HTMLElement>('.user-message-bubble-color')
  )) {
    add('user', bubble);
  }

  for (const answer of Array.from(
    scope.querySelectorAll<HTMLElement>('.markdown.prose, .markdown-new-styling, .markdown')
  )) {
    if (answer.closest('.user-message-bubble-color')) continue;
    if (answer.parentElement?.closest('.markdown, .markdown-new-styling')) continue;
    add('assistant', answer);
  }

  candidates.sort((left, right) => {
    if (left.host === right.host) return 0;
    const position = left.host.compareDocumentPosition(right.host);
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  return candidates;
}

export function collectReaderTurns(root: ParentNode = document): ReaderTurn[] {
  const turns: ReaderTurn[] = [];
  let current: ReaderTurn | null = null;

  for (const candidate of collectMessageCandidates(root)) {
    const { role, content, host } = candidate;
    if (role === 'user') {
      const title = normalizeText(content) || `第 ${turns.length + 1} 轮`;
      current = {
        id: createTurnId(content, host, turns.length),
        question: content,
        answers: [],
        host,
        title,
        questionText: title,
        answerTexts: [],
      };
      turns.push(current);
    } else if (role === 'assistant' && current) {
      current.answers.push(content);
      current.answerTexts.push(normalizeText(content));
    }
  }

  return turns;
}

export function recordsToReaderTurns(records: ReaderMessageRecord[]): ReaderTurn[] {
  const turns: ReaderTurn[] = [];
  let current: ReaderTurn | null = null;
  for (const record of records) {
    if (record.role === 'user') {
      current = {
        id: record.id,
        question: null,
        answers: [],
        host: null,
        title: record.text.replace(/\s+/g, ' ').trim() || `第 ${turns.length + 1} 轮`,
        questionText: record.text,
        answerTexts: [],
      };
      turns.push(current);
    } else if (current) {
      current.answerTexts.push(record.text);
    }
  }
  return turns;
}

function getHeaderOffset(): number {
  let offset = HEADER_FALLBACK_PX;
  for (const element of Array.from(
    document.querySelectorAll<HTMLElement>('header, [role="banner"]')
  )) {
    const style = getComputedStyle(element);
    if (style.position !== 'fixed' && style.position !== 'sticky') continue;
    const rect = element.getBoundingClientRect();
    if (rect.top <= 1 && rect.bottom > 0) offset = Math.max(offset, rect.bottom);
  }
  return Math.ceil(offset + 16);
}

function scrollContainerFor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current && current !== document.body) {
    const style = getComputedStyle(current);
    if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function scrollQuestionIntoView(question: HTMLElement, smooth: boolean): void {
  const behavior: ScrollBehavior = smooth ? 'smooth' : 'auto';
  const offset = getHeaderOffset();
  const container = scrollContainerFor(question);
  if (container) {
    const targetRect = question.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const top = container.scrollTop + targetRect.top - containerRect.top - offset;
    container.scrollTo({ top: Math.max(0, top), behavior });
    return;
  }
  const top = window.scrollY + question.getBoundingClientRect().top - offset;
  window.scrollTo({ top: Math.max(0, top), behavior });
}

async function copyTurn(turn: ReaderTurn, button: HTMLButtonElement): Promise<void> {
  const question = turn.questionText;
  const answer = turn.answerTexts.filter(Boolean).join('\n\n');
  const text = `问题：\n${question}\n\n回答：\n${answer}`;

  try {
    await navigator.clipboard.writeText(text);
    button.textContent = '已复制';
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    button.textContent = '已复制';
  }

  window.setTimeout(() => {
    button.textContent = '复制本轮';
  }, 1400);
}

function positionStorageKey(): string | null {
  const conversationId = extractConversationPageId(location.href);
  return conversationId ? readerPositionKey(conversationId) : null;
}

export function installReaderSidebar(): ReaderSidebarController {
  let enabled = false;
  let turns: ReaderTurn[] = [];
  let activeId: string | null = null;
  let restoredKey: string | null = null;
  let mutationObserver: MutationObserver | null = null;
  let renderTimer: number | null = null;
  let saveTimer: number | null = null;
  let scrollFrame: number | null = null;
  let sidebar: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let hasRenderedList = false;
  let apiTurns: ReaderTurn[] = [];
  let readerRequestId: string | null = null;
  let readerLoadTimer: number | null = null;
  let readerState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  let readerError = '';
  let apiRecords: ReaderMessageRecord[] = [];
  let readerConversationTitle = '';

  function ensureSidebar(): void {
    if (sidebar?.isConnected) return;

    sidebar = document.createElement('aside');
    sidebar.className = 'ls-reader-sidebar';
    sidebar.setAttribute('aria-label', '对话目录');
    sidebar.innerHTML = `
      <div class="ls-reader-sidebar__header">
        <div>
          <strong>对话目录</strong>
          <span class="ls-reader-sidebar__count"></span>
        </div>
        <div class="ls-reader-sidebar__actions">
          <button type="button" class="ls-reader-sidebar__desktop" title="同步并在 Mica 中打开">同步到 Mica</button>
          <button type="button" class="ls-reader-sidebar__toggle" aria-label="收起目录">−</button>
        </div>
      </div>
      <nav class="ls-reader-sidebar__list" aria-label="提问目录"></nav>
    `;
    document.body.appendChild(sidebar);
    list = sidebar.querySelector<HTMLElement>('.ls-reader-sidebar__list');

    sidebar
      .querySelector<HTMLButtonElement>('.ls-reader-sidebar__desktop')
      ?.addEventListener('click', (event) => void syncToDesktop(event.currentTarget as HTMLButtonElement));

    sidebar
      .querySelector<HTMLButtonElement>('.ls-reader-sidebar__toggle')
      ?.addEventListener('click', (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        const collapsed = sidebar?.classList.toggle('is-collapsed') ?? false;
        button.textContent = collapsed ? '+' : '−';
        button.setAttribute('aria-label', collapsed ? '展开目录' : '收起目录');
      });
  }

  async function syncToDesktop(button: HTMLButtonElement): Promise<void> {
    const conversationId = extractConversationPageId(location.href);
    const records = recordsForReader();
    if (!conversationId || records.length === 0) {
      button.textContent = '暂无内容';
      window.setTimeout(() => { if (button.isConnected) button.textContent = '同步到 Mica'; }, 1800);
      return;
    }
    const original = button.textContent;
    button.disabled = true;
    button.textContent = '同步中…';
    try {
      await sendMessageWithTimeout<SyncDesktopResponse>(
        {
          type: 'SYNC_DESKTOP',
          open: true,
          conversation: {
            version: 1,
            id: conversationId,
            title: readerConversationTitle || document.title.replace(/\s*[|—-]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT 对话',
            sourceUrl: location.href,
            updatedAt: new Date().toISOString(),
            messages: records,
          },
        },
        10_000
      );
      button.textContent = '已打开';
    } catch {
      button.textContent = '未安装';
      button.title = '请先安装并注册 LightSession 桌面端';
    } finally {
      window.setTimeout(() => {
        if (!button.isConnected) return;
        button.disabled = false;
        button.textContent = original;
      }, 2200);
    }
  }

  function decorateTurns(): void {
    for (const turn of turns) {
      if (!turn.question || !turn.host) continue;
      turn.question.classList.add('ls-reader-question');
      turn.question.dataset.lsReaderTurnId = turn.id;

      const { host } = turn;
      if (host.querySelector(`[data-ls-copy-turn="${CSS.escape(turn.id)}"]`)) continue;

      host.classList.add('ls-reader-unit');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ls-reader-copy';
      button.dataset.lsCopyTurn = turn.id;
      button.textContent = '复制本轮';
      button.addEventListener('click', () => void copyTurn(turn, button));
      host.appendChild(button);
    }
  }

  function renderList(): void {
    ensureSidebar();
    if (!list || !sidebar) return;

    const fragment = document.createDocumentFragment();
    turns.forEach((turn, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ls-reader-toc-item';
      button.dataset.turnId = turn.id;
      button.title = turn.title;
      button.innerHTML = `<span>${index + 1}</span><b></b>`;
      const label = button.querySelector('b');
      if (label) label.textContent = turn.title;
      button.addEventListener('click', () => void openReaderAtTurn(turn, button));
      fragment.appendChild(button);
    });

    if (turns.length === 0) {
      const status = document.createElement('div');
      status.className = 'ls-reader-sidebar__empty';
      status.textContent =
        readerState === 'loading'
          ? '正在读取当前对话…'
          : readerState === 'error'
            ? `读取失败：${readerError}`
            : '打开一个对话后，这里会显示提问目录。';
      fragment.appendChild(status);
    }

    list.replaceChildren(fragment);
    const count = sidebar.querySelector<HTMLElement>('.ls-reader-sidebar__count');
    if (count) {
      count.textContent =
        readerState === 'loading'
          ? '读取中…'
          : readerState === 'error' && turns.length === 0
            ? '读取失败'
            : `${turns.length} 轮`;
      count.title = readerError;
    }
    sidebar.hidden = false;
    hasRenderedList = true;
    updateActiveItem(activeId);
  }

  function recordsForReader(): ReaderMessageRecord[] {
    if (apiRecords.length > 0) return apiRecords;
    return turns.flatMap((turn) => [
      { id: turn.id, role: 'user' as const, text: turn.questionText },
      ...turn.answerTexts.map((text, index) => ({
        id: `${turn.id}:assistant:${index}`,
        role: 'assistant' as const,
        text,
      })),
    ]);
  }

  async function openReaderAtTurn(turn: ReaderTurn, button: HTMLButtonElement): Promise<void> {
    const conversationId = extractConversationPageId(location.href);
    if (!conversationId) return;
    const label = button.querySelector('b');
    const originalLabel = label?.textContent ?? turn.title;
    if (label) label.textContent = '正在打开阅读器…';

    try {
      const records = recordsForReader();
      const key = readerSnapshotKey(conversationId);
      const signature = readerRecordsSignature(records);
      const stored = (await browser.storage.local.get(key)) as Record<string, unknown>;
      const previous = stored[key] as Partial<ReaderConversationSnapshot> | undefined;
      if (previous?.signature !== signature) {
        const snapshot: ReaderConversationSnapshot = {
          version: 1,
          conversationId,
          title:
            readerConversationTitle ||
            document.title.replace(/\s*[|—-]\s*ChatGPT\s*$/i, '').trim() ||
            'ChatGPT 对话',
          signature,
          records,
        };
        await browser.storage.local.set({ [key]: snapshot });
      }
      await sendMessageWithTimeout<OpenReaderResponse>(
        { type: 'OPEN_READER', conversationId, messageId: turn.id },
        2000
      );
      if (label?.isConnected) label.textContent = originalLabel;
    } catch {
      if (label) label.textContent = '打开失败，点击重试';
      window.setTimeout(() => {
        if (label?.isConnected) label.textContent = originalLabel;
      }, 2500);
    }
  }

  function updateActiveItem(id: string | null): void {
    activeId = id;
    for (const turn of turns) {
      turn.question?.classList.toggle('is-active', turn.id === id);
    }
    for (const item of Array.from(
      list?.querySelectorAll<HTMLElement>('.ls-reader-toc-item') ?? []
    )) {
      const selected = item.dataset.turnId === id;
      item.classList.toggle('is-active', selected);
      if (selected) item.scrollIntoView({ block: 'nearest' });
    }
  }

  function schedulePositionSave(id: string): void {
    const key = positionStorageKey();
    if (!key) return;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void browser.storage.local.get(key).then((storedValue) => {
        const stored = storedValue as Record<string, unknown>;
        if (stored[key] === id) return;
        return browser.storage.local.set({ [key]: id });
      });
    }, SAVE_DELAY_MS);
  }

  function detectActiveTurn(): void {
    scrollFrame = null;
    if (!enabled || turns.length === 0) return;

    const threshold = getHeaderOffset() + 8;
    const visibleTurns = turns.filter(
      (turn): turn is ReaderTurn & { question: HTMLElement } => turn.question !== null
    );
    if (visibleTurns.length === 0) return;
    let current = visibleTurns[0];
    for (const turn of visibleTurns) {
      if (turn.question.getBoundingClientRect().top <= threshold) current = turn;
      else break;
    }

    if (current?.id && current.id !== activeId) {
      updateActiveItem(current.id);
      schedulePositionSave(current.id);
    }
  }

  function handleScroll(): void {
    if (scrollFrame === null) scrollFrame = window.requestAnimationFrame(detectActiveTurn);
  }

  async function restorePosition(): Promise<void> {
    const key = positionStorageKey();
    if (!key || key === restoredKey || turns.length === 0) return;
    restoredKey = key;
    const stored = (await browser.storage.local.get(key)) as Record<string, unknown>;
    const id = stored[key];
    if (typeof id !== 'string') return;
    const turn = turns.find((candidate) => candidate.id === id);
    if (!turn) return;
    updateActiveItem(turn.id);
    if (turn.question) window.setTimeout(() => scrollQuestionIntoView(turn.question!, false), 50);
  }

  function mergeApiAndDomTurns(domTurns: ReaderTurn[]): ReaderTurn[] {
    if (apiTurns.length === 0) return domTurns;
    const unusedDom = new Set(domTurns);
    return apiTurns.map((apiTurn) => {
      const domTurn =
        domTurns.find((candidate) => candidate.id === apiTurn.id) ??
        domTurns.find(
          (candidate) => unusedDom.has(candidate) && candidate.title === apiTurn.title
        ) ??
        null;
      if (domTurn) unusedDom.delete(domTurn);
      return {
        ...apiTurn,
        question: domTurn?.question ?? null,
        answers: domTurn?.answers ?? [],
        host: domTurn?.host ?? null,
      };
    });
  }

  function requestConversationIndex(): void {
    const conversationId = extractConversationPageId(location.href);
    ensureSidebar();
    if (!conversationId) {
      readerState = 'idle';
      apiTurns = [];
      apiRecords = [];
      readerConversationTitle = '';
      scheduleRender();
      return;
    }
    readerRequestId = `${conversationId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    readerState = 'loading';
    readerError = '';
    if (readerLoadTimer !== null) window.clearTimeout(readerLoadTimer);
    const pendingRequestId = readerRequestId;
    readerLoadTimer = window.setTimeout(() => {
      readerLoadTimer = null;
      if (readerRequestId !== pendingRequestId || readerState !== 'loading') return;
      readerState = 'error';
      readerError = '读取超时，请刷新页面后重试';
      renderList();
    }, 8000);
    renderList();
    window.dispatchEvent(
      new CustomEvent('lightsession-reader-request', {
        detail: JSON.stringify({ requestId: readerRequestId, conversationId }),
      })
    );
  }

  function handleReaderResult(event: Event): void {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== 'string') return;
    try {
      const result = JSON.parse(detail) as {
        requestId?: unknown;
        records?: unknown;
        error?: unknown;
        title?: unknown;
      };
      if (result.requestId !== readerRequestId) return;
      if (readerLoadTimer !== null) window.clearTimeout(readerLoadTimer);
      readerLoadTimer = null;
      if (typeof result.error === 'string') {
        readerState = 'error';
        readerError = result.error;
      } else if (Array.isArray(result.records)) {
        const validRecords = result.records.filter(
          (record): record is ReaderMessageRecord =>
            !!record &&
            typeof record === 'object' &&
            typeof (record as ReaderMessageRecord).id === 'string' &&
            ((record as ReaderMessageRecord).role === 'user' ||
              (record as ReaderMessageRecord).role === 'assistant') &&
            typeof (record as ReaderMessageRecord).text === 'string'
        );
        apiRecords = validRecords;
        readerConversationTitle = typeof result.title === 'string' ? result.title.trim() : '';
        apiTurns = recordsToReaderTurns(validRecords);
        readerState = 'ready';
      }
      scheduleRender();
    } catch {
      // Ignore malformed page-world results.
    }
  }

  function render(): void {
    renderTimer = null;
    if (!enabled) return;
    const nextTurns =
      readerState === 'loading' ? apiTurns : mergeApiAndDomTurns(collectReaderTurns());
    const signature = nextTurns.map((turn) => turn.id).join('|');
    const previousSignature = turns.map((turn) => turn.id).join('|');
    turns = nextTurns;
    decorateTurns();
    if (signature !== previousSignature || !sidebar?.isConnected || !hasRenderedList) renderList();
    void restorePosition().finally(handleScroll);
  }

  function scheduleRender(): void {
    if (renderTimer !== null) return;
    renderTimer = window.setTimeout(render, 180);
  }

  function start(): void {
    if (enabled) return;
    enabled = true;
    ensureSidebar();
    mutationObserver = new MutationObserver(scheduleRender);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('lightsession-reader-result', handleReaderResult);
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll, { passive: true });
    scheduleRender();
    requestConversationIndex();
  }

  function stop(): void {
    enabled = false;
    mutationObserver?.disconnect();
    mutationObserver = null;
    window.removeEventListener('scroll', handleScroll);
    window.removeEventListener('resize', handleScroll);
    window.removeEventListener('lightsession-reader-result', handleReaderResult);
    if (renderTimer !== null) window.clearTimeout(renderTimer);
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame);
    if (readerLoadTimer !== null) window.clearTimeout(readerLoadTimer);
    renderTimer = null;
    saveTimer = null;
    scrollFrame = null;
    readerLoadTimer = null;
    sidebar?.remove();
    sidebar = null;
    list = null;
    hasRenderedList = false;
    for (const turn of turns) {
      turn.question?.classList.remove('ls-reader-question', 'is-active');
      const { host } = turn;
      host?.classList.remove('ls-reader-unit');
      host?.querySelector<HTMLElement>('[data-ls-copy-turn]')?.remove();
    }
    turns = [];
    activeId = null;
  }

  return {
    enable: start,
    refreshForNavigation(): void {
      restoredKey = null;
      activeId = null;
      turns = [];
      apiTurns = [];
      apiRecords = [];
      readerConversationTitle = '';
      requestConversationIndex();
      scheduleRender();
    },
    teardown: stop,
  };
}

