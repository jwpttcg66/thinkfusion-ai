/**
 * P2-01：知识卡存储。原子写、旧数据兼容、一卡一结论。
 *
 * 规则：
 * - 没有 EvidenceRef 的卡不落盘（只能当草稿，草稿在内存里都不建）；
 * - 新卡可以 supersedes 旧卡；旧卡标 superseded，不删除；
 * - 时间字段由调用方给，store 只负责完整性与持久化。
 */
import fs from 'node:fs';
import { writeFileAtomic } from '../atomic-write';
import type { CardStatus, KnowledgeCard, KnowledgeFile, Topic } from './types';

function empty(): KnowledgeFile {
  return { version: 1, topics: [], cards: [] };
}

function normalize(raw: unknown): KnowledgeFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty();
  const value = raw as Partial<KnowledgeFile>;
  const topics = Array.isArray(value.topics)
    ? value.topics.filter((item): item is Topic => !!item && typeof item.topicId === 'string')
    : [];
  const cards = Array.isArray(value.cards)
    ? value.cards.filter((item): item is KnowledgeCard => !!item && typeof item.cardId === 'string')
    : [];
  return { version: 1, topics, cards };
}

export class KnowledgeStore {
  constructor(private readonly file: string) {}

  load(): KnowledgeFile {
    try {
      return normalize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return empty();
    }
  }

  save(data: KnowledgeFile): void {
    writeFileAtomic(this.file, JSON.stringify(data, null, 2), 0o600);
  }

  upsertTopic(input: Omit<Topic, 'createdAt' | 'updatedAt'> & Partial<Pick<Topic, 'createdAt'>>): Topic {
    const data = this.load();
    const now = Date.now();
    const existing = data.topics.find(item => item.topicId === input.topicId);
    const topic: Topic = existing
      ? { ...existing, title: input.title, aliases: input.aliases, updatedAt: now }
      : { ...input, createdAt: input.createdAt ?? now, updatedAt: now };
    data.topics = existing
      ? data.topics.map(item => (item.topicId === input.topicId ? topic : item))
      : [...data.topics, topic];
    this.save(data);
    return topic;
  }

  /** 新卡必须带证据；同一 cardId 不允许静默覆盖。 */
  addCard(card: Omit<KnowledgeCard, 'createdAt' | 'updatedAt'>): KnowledgeCard {
    if (card.evidenceRefs.length === 0) throw new Error('知识卡必须至少有一个 EvidenceRef');
    const data = this.load();
    if (data.cards.some(item => item.cardId === card.cardId)) {
      throw new Error(`知识卡已存在：${card.cardId}`);
    }
    const now = Date.now();
    const next: KnowledgeCard = { ...card, createdAt: now, updatedAt: now };
    if (next.supersedes) {
      data.cards = data.cards.map(item =>
        item.cardId === next.supersedes ? { ...item, status: 'superseded', updatedAt: now } : item
      );
    }
    data.cards = [...data.cards, next];
    this.save(data);
    return next;
  }

  setStatus(cardId: string, status: CardStatus): KnowledgeCard {
    const data = this.load();
    const card = data.cards.find(item => item.cardId === cardId);
    if (!card) throw new Error(`未知知识卡：${cardId}`);
    const next = { ...card, status, updatedAt: Date.now() };
    data.cards = data.cards.map(item => (item.cardId === cardId ? next : item));
    this.save(data);
    return next;
  }

  listCards(): KnowledgeCard[] {
    return this.load().cards;
  }

  listTopics(): Topic[] {
    return this.load().topics;
  }

  getCard(cardId: string): KnowledgeCard | null {
    return this.load().cards.find(item => item.cardId === cardId) ?? null;
  }
}
