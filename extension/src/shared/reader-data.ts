export type ReaderMessageRole = 'user' | 'assistant';

export interface ReaderMessageRecord {
  id: string;
  role: ReaderMessageRole;
  text: string;
  time?: number | null;
  voice?: boolean;
}

export interface ReaderConversationSnapshot {
  version: 1;
  conversationId: string;
  title: string;
  signature: string;
  records: ReaderMessageRecord[];
}

export interface ReaderUnit {
  id: string;
  question: string;
  questionTime: number | null;
  answers: string[];
  answerTimes: Array<number | null>;
}

export const READER_SNAPSHOT_PREFIX = 'ls_reader_conversation_';
export const READER_POSITION_PREFIX = 'ls_reader_position_';

export function readerSnapshotKey(conversationId: string): string {
  return `${READER_SNAPSHOT_PREFIX}${conversationId}`;
}

export function readerPositionKey(conversationId: string): string {
  return `${READER_POSITION_PREFIX}${conversationId}`;
}

export function readerRecordsSignature(records: ReaderMessageRecord[]): string {
  let hash = 2166136261;
  for (const record of records) {
    const value = `${record.id}\u0000${record.role}\u0000${record.time ?? ''}\u0000${record.voice ? '1' : '0'}\u0000${record.text}\u0001`;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${records.length}:${(hash >>> 0).toString(36)}`;
}

export function recordsToReaderUnits(records: ReaderMessageRecord[]): ReaderUnit[] {
  const units: ReaderUnit[] = [];
  let current: ReaderUnit | null = null;
  for (const record of records) {
    if (record.role === 'user') {
      current = {
        id: record.id,
        question: record.text,
        questionTime: record.time ?? null,
        answers: [],
        answerTimes: [],
      };
      units.push(current);
    } else if (current) {
      const lastAnswer = current.answers.length - 1;
      if (lastAnswer >= 0) {
        current.answers[lastAnswer] = `${current.answers[lastAnswer]}\n\n${record.text}`;
      } else {
        current.answers.push(record.text);
        current.answerTimes.push(record.time ?? null);
      }
    }
  }
  return units;
}

export function isReaderSnapshot(value: unknown): value is ReaderConversationSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<ReaderConversationSnapshot>;
  return (
    snapshot.version === 1 &&
    typeof snapshot.conversationId === 'string' &&
    typeof snapshot.title === 'string' &&
    typeof snapshot.signature === 'string' &&
    Array.isArray(snapshot.records) &&
    snapshot.records.every(
      (record) =>
        !!record &&
        typeof record.id === 'string' &&
        (record.role === 'user' || record.role === 'assistant') &&
        typeof record.text === 'string' &&
        (record.time === undefined || record.time === null || typeof record.time === 'number')
    )
  );
}

