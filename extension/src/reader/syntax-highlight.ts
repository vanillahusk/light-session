const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  md: 'markdown',
  cs: 'csharp',
  cpp: 'cpp',
};

const KEYWORDS: Record<string, Set<string>> = {
  javascript: new Set(
    'async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch throw try typeof var void while with yield'.split(
      ' '
    )
  ),
  typescript: new Set(
    'abstract any as asserts async await boolean break case catch class const constructor continue declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new number object of override private protected public readonly require return satisfies set static string super switch symbol this throw try type typeof undefined unique unknown var void while with yield'.split(
      ' '
    )
  ),
  java: new Set(
    'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while'.split(
      ' '
    )
  ),
  python: new Set(
    'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield'.split(
      ' '
    )
  ),
  shell: new Set(
    'case do done elif else esac export fi for function if in local readonly return select then time until while'.split(
      ' '
    )
  ),
  sql: new Set(
    'add all alter and any as asc backup between by case check column constraint create database default delete desc distinct drop exec exists foreign from full group having in index inner insert into is join key left like limit not null on or order outer primary procedure right rownum select set table top truncate union unique update values view where'.split(
      ' '
    )
  ),
  c: new Set(
    'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while'.split(
      ' '
    )
  ),
  cpp: new Set(
    'alignas alignof and asm auto bool break case catch char class const constexpr continue decltype default delete do double else enum explicit export extern false float for friend goto if inline int long namespace new noexcept nullptr operator private protected public register reinterpret_cast return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while'.split(
      ' '
    )
  ),
  csharp: new Set(
    'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while'.split(
      ' '
    )
  ),
  go: new Set(
    'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'.split(
      ' '
    )
  ),
  rust: new Set(
    'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(
      ' '
    )
  ),
  kotlin: new Set(
    'as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while'.split(
      ' '
    )
  ),
};

const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'nil', 'None', 'True', 'False']);

function appendToken(target: HTMLElement, value: string, kind?: string): void {
  if (!kind) {
    target.append(document.createTextNode(value));
    return;
  }
  const span = document.createElement('span');
  span.className = `tok-${kind}`;
  span.textContent = value;
  target.append(span);
}

function readQuoted(code: string, start: number, quote: string): number {
  let index = start + quote.length;
  while (index < code.length) {
    if (code[index] === '\\') index += 2;
    else if (code.startsWith(quote, index)) return index + quote.length;
    else index += 1;
  }
  return code.length;
}

function highlightMarkup(code: string, target: HTMLElement): void {
  let cursor = 0;
  const pattern = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g;
  for (const match of code.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) appendToken(target, code.slice(cursor, index));
    const token = match[0];
    if (token.startsWith('<!--')) {
      appendToken(target, token, 'comment');
    } else {
      const name = token.match(/^<\/?\s*([\w:-]+)/)?.[1];
      const openLength = token.startsWith('</') ? 2 : 1;
      appendToken(target, token.slice(0, openLength), 'punctuation');
      if (name) {
        appendToken(target, name, 'tag');
        const restStart = token.indexOf(name) + name.length;
        appendToken(target, token.slice(restStart), 'attribute');
      } else {
        appendToken(target, token, 'tag');
      }
    }
    cursor = index + token.length;
  }
  if (cursor < code.length) appendToken(target, code.slice(cursor));
}

export function highlightCode(source: string, language: string, target: HTMLElement): void {
  target.replaceChildren();
  const normalized = LANGUAGE_ALIASES[language.toLocaleLowerCase()] ?? language.toLocaleLowerCase();
  target.dataset.language = normalized || 'text';
  if (normalized === 'markup') {
    highlightMarkup(source, target);
    return;
  }

  const keywords = KEYWORDS[normalized] ?? new Set<string>();
  const hashComments = normalized === 'python' || normalized === 'shell' || normalized === 'yaml';
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    if (rest.startsWith('//') || (hashComments && rest.startsWith('#'))) {
      const end = source.indexOf('\n', index);
      const next = end === -1 ? source.length : end;
      appendToken(target, source.slice(index, next), 'comment');
      index = next;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = source.indexOf('*/', index + 2);
      const next = end === -1 ? source.length : end + 2;
      appendToken(target, source.slice(index, next), 'comment');
      index = next;
      continue;
    }
    const quote = source[index];
    if (quote === '"' || quote === "'" || quote === '`') {
      const next = readQuoted(source, index, quote);
      const value = source.slice(index, next);
      const after = source.slice(next).match(/^\s*/)?.[0].length ?? 0;
      const property = normalized === 'json' && source[next + after] === ':';
      appendToken(target, value, property ? 'property' : 'string');
      index = next;
      continue;
    }
    const number = rest.match(/^(?:0[xob][\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)[a-z]*/i);
    if (number) {
      appendToken(target, number[0], 'number');
      index += number[0].length;
      continue;
    }
    const identifier = rest.match(/^[A-Za-z_$][\w$]*/);
    if (identifier) {
      const value = identifier[0];
      const after = rest.slice(value.length).match(/^\s*/)?.[0].length ?? 0;
      const nextCharacter = rest[value.length + after];
      const kind = keywords.has(value)
        ? 'keyword'
        : LITERALS.has(value)
          ? 'literal'
          : nextCharacter === '('
            ? 'function'
            : /^[A-Z]/.test(value)
              ? 'type'
              : undefined;
      appendToken(target, value, kind);
      index += value.length;
      continue;
    }
    const operator = rest.match(/^(?:===?|!==?|=>|<=?|>=?|\+\+|--|&&|\|\||\?\?|[+*/%=&|!^~?:-])/);
    if (operator) {
      appendToken(target, operator[0], 'operator');
      index += operator[0].length;
      continue;
    }
    appendToken(target, source[index] ?? '');
    index += 1;
  }
}

