import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.resetModules();
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
});

function addMessage(role: 'user' | 'assistant', id: string, text: string): void {
  const article = document.createElement('article');
  article.dataset.testid = `conversation-turn-${id}`;
  const message = document.createElement('div');
  message.dataset.messageAuthorRole = role;
  message.innerText = text;
  article.appendChild(message);
  document.body.appendChild(article);
}

describe('reader sidebar turn collection', () => {
  it('groups a user prompt and following assistant messages into one unit', async () => {
    addMessage('user', '1', '第一个问题');
    addMessage('assistant', '2', '第一段回答');
    addMessage('assistant', '3', '第二段回答');
    addMessage('user', '4', '第二个问题');
    addMessage('assistant', '5', '第二轮回答');

    const { collectReaderTurns } = await import('../../extension/src/content/reader-sidebar');
    const turns = collectReaderTurns(document);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.title).toBe('第一个问题');
    expect(turns[0]?.answers).toHaveLength(2);
    expect(turns[1]?.title).toBe('第二个问题');
    expect(turns[1]?.answers).toHaveLength(1);
  });

  it('ignores assistant messages that appear before the first user prompt', async () => {
    addMessage('assistant', '0', '系统欢迎语');
    addMessage('user', '1', '问题');
    addMessage('assistant', '2', '回答');

    const { collectReaderTurns } = await import('../../extension/src/content/reader-sidebar');
    const turns = collectReaderTurns(document);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.answers).toHaveLength(1);
  });

  it('supports data-turn containers when role roots are absent', async () => {
    document.body.innerHTML = `
      <main>
        <section data-turn="user" data-turn-id="u1"><div class="user-message-bubble-color"><div class="whitespace-pre-wrap">新版问题</div></div></section>
        <section data-turn="assistant" data-turn-id="a1"><div class="markdown prose">新版回答</div></section>
      </main>
    `;

    const { collectReaderTurns } = await import('../../extension/src/content/reader-sidebar');
    const turns = collectReaderTurns(document);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.title).toBe('新版问题');
    expect(turns[0]?.answers[0]?.innerText).toBe('新版回答');
  });

  it('falls back to user bubbles and markdown blocks', async () => {
    document.body.innerHTML = `
      <main>
        <div class="user-message-bubble-color"><div class="whitespace-pre-wrap">回退问题</div></div>
        <div class="markdown">回退回答</div>
      </main>
    `;

    const { collectReaderTurns } = await import('../../extension/src/content/reader-sidebar');
    const turns = collectReaderTurns(document);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.title).toBe('回退问题');
    expect(turns[0]?.answers).toHaveLength(1);
  });
});

