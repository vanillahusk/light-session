import browser from '../shared/browser-polyfill';
import { extractConversationPageId } from '../shared/url';

const POSITION_PREFIX = 'ls_reader_position_';
const SAVE_DELAY_MS = 1200;
const HEADER_FALLBACK_PX = 72;

interface ReaderTurn {
  id: string;
  question: HTMLElement;
  answers: HTMLElement[];
  host: HTMLElement;
  title: string;
}

type MessageRole = 'user' | 'assistant';

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
    host.dataset.turnId ??
    question.closest<HTMLElement>('[data-message-id]')?.dataset.messageId;
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
      '[data-message-id], [data-turn-id], [data-testid^="conversation-turn"], article'
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
      };
      turns.push(current);
    } else if (role === 'assistant' && current) {
      current.answers.push(content);
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

function scrollQuestionIntoView(question: HTMLElement, smooth: boolean): void {
  const top = window.scrollY + question.getBoundingClientRect().top - getHeaderOffset();
  window.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}

async function copyTurn(turn: ReaderTurn, button: HTMLButtonElement): Promise<void> {
  const question = normalizeText(turn.question);
  const answer = turn.answers.map(normalizeText).filter(Boolean).join('\n\n');
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
  return conversationId ? `${POSITION_PREFIX}${conversationId}` : null;
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
        <button type="button" class="ls-reader-sidebar__toggle" aria-label="收起目录">−</button>
      </div>
      <nav class="ls-reader-sidebar__list" aria-label="提问目录"></nav>
    `;
    document.body.appendChild(sidebar);
    list = sidebar.querySelector<HTMLElement>('.ls-reader-sidebar__list');

    sidebar
      .querySelector<HTMLButtonElement>('.ls-reader-sidebar__toggle')
      ?.addEventListener('click', (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        const collapsed = sidebar?.classList.toggle('is-collapsed') ?? false;
        button.textContent = collapsed ? '+' : '−';
        button.setAttribute('aria-label', collapsed ? '展开目录' : '收起目录');
      });
  }

  function decorateTurns(): void {
    for (const turn of turns) {
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
      button.addEventListener('click', () => scrollQuestionIntoView(turn.question, true));
      fragment.appendChild(button);
    });

    list.replaceChildren(fragment);
    const count = sidebar.querySelector<HTMLElement>('.ls-reader-sidebar__count');
    if (count) count.textContent = `${turns.length} 轮`;
    sidebar.hidden = turns.length === 0;
    hasRenderedList = true;
    updateActiveItem(activeId);
  }

  function updateActiveItem(id: string | null): void {
    activeId = id;
    for (const turn of turns) {
      turn.question.classList.toggle('is-active', turn.id === id);
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
    let current = turns[0];
    for (const turn of turns) {
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
    window.setTimeout(() => scrollQuestionIntoView(turn.question, false), 50);
  }

  function render(): void {
    renderTimer = null;
    if (!enabled) return;
    const nextTurns = collectReaderTurns();
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
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll, { passive: true });
    scheduleRender();
  }

  function stop(): void {
    enabled = false;
    mutationObserver?.disconnect();
    mutationObserver = null;
    window.removeEventListener('scroll', handleScroll);
    window.removeEventListener('resize', handleScroll);
    if (renderTimer !== null) window.clearTimeout(renderTimer);
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame);
    renderTimer = null;
    saveTimer = null;
    scrollFrame = null;
    sidebar?.remove();
    sidebar = null;
    list = null;
    hasRenderedList = false;
    for (const turn of turns) {
      turn.question.classList.remove('ls-reader-question', 'is-active');
      const { host } = turn;
      host.classList.remove('ls-reader-unit');
      host.querySelector<HTMLElement>('[data-ls-copy-turn]')?.remove();
    }
    turns = [];
    activeId = null;
  }

  return {
    enable: start,
    refreshForNavigation(): void {
      restoredKey = null;
      activeId = null;
      scheduleRender();
    },
    teardown: stop,
  };
}

