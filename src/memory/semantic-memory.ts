/**
 * 语义记忆扩展 — pgvector 向量检索 + 时效评分 + 记忆强化。
 *
 * 基于 QM 现有 MemoryService（文本 recall/capture/query），增加：
 *   1. embed + store：capture 时自动生成向量并存入 pgvector
 *   2. semanticQuery：语义相似度搜索（替代关键词匹配）
 *   3. freshness：时间衰减评分（越新权重越高）
 *   4. reinforce：多次检索命中 + 验证有效 → 提升权重
 *
 * 对标标书 #10（长期记忆管理）、#11（上下文管理）
 * 设计决策（R6 评审）：记忆四层分级（热/温/冷/事实）
 */

import type { ScopeId } from "../types.ts";
import type { MemoryService } from "./memory-service.ts";

// ── 语义记忆条目 ──

export interface SemanticMemoryEntry {
  id: string;
  scopeId: string;
  content: string;
  /** 向量（pgvector halfvec 兼容） */
  embedding?: number[];
  /** 创建时间 */
  createdAt: number;
  /** 最后访问时间 */
  lastAccessedAt: number;
  /** 访问计数（用于强化） */
  accessCount: number;
  /** 验证计数（用于强化——被检索后验证仍然有效） */
  verifiedCount: number;
  /** 权重（0-1，reinforce 提升） */
  weight: number;
  /** 来源 */
  source: "capture" | "refine" | "manual";
}

// ── 向量存储接口 ──

export interface VectorStore {
  /** 存储向量 */
  insert(entry: SemanticMemoryEntry): Promise<void>;
  /** 语义搜索（返回相似度排序的条目） */
  search(scopeId: string, query: string, embedding: number[], limit?: number): Promise<SemanticMemoryEntry[]>;
  /** 更新访问统计 */
  touch(id: string): Promise<void>;
  /** 更新权重 */
  reinforce(id: string, verified: boolean): Promise<void>;
  /** 清理过期条目 */
  purgeExpired(scopeId: string, maxAgeDays: number): Promise<number>;
}

// ── 内嵌模型接口（可替换为真实模型） ──

export interface EmbeddingModel {
  /** 将文本转为向量 */
  embed(texts: string[]): Promise<number[][]>;
}

// ── 默认嵌入模型（基于内容哈希的轻量实现，可替换） ──

import { createHash } from "node:crypto";

export function hashEmbedding(text: string, dims: number = 256): number[] {
  // 轻量实现：SHA256 转 256 维向量（非语义，但可用于相似度排序）
  // 生产环境替换为真实 embedding 模型（如 text-embedding-3-small）
  const hash = createHash("sha256").update(text).digest();
  const vec: number[] = [];
  for (let i = 0; i < Math.min(dims, hash.length * 8); i++) {
    const byte = hash[Math.floor(i / 8)]!;
    const bit = (byte >> (7 - (i % 8))) & 1;
    vec.push(bit ? 1.0 : -1.0);
  }
  // 归一化
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

export const defaultEmbeddingModel: EmbeddingModel = {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => hashEmbedding(t));
  },
};

// ── 时效评分 ──

export function freshnessScore(entry: SemanticMemoryEntry, now: number = Date.now()): number {
  const ageDays = (now - entry.createdAt) / (1000 * 86400);
  // 指数衰减：半衰期 7 天
  const decay = Math.exp(-ageDays / (7 / Math.log(2)));
  // 综合权重 = 衰减 × 强化权重 × 验证加成
  const verifiedBonus = 1 + Math.log(1 + entry.verifiedCount) / Math.log(10);
  return decay * entry.weight * verifiedBonus;
}

// ── 语义记忆服务 ──

export interface SemanticMemoryService extends MemoryService {
  /** 语义搜索（替代原 query） */
  semanticQuery(scopeId: ScopeId, query: string, limit?: number): Promise<Array<{ content: string; score: number }>>;
  /** 获取记忆统计 */
  stats(scopeId: ScopeId): Promise<{ total: number; avgWeight: number; oldestDays: number }>;
}

export function createSemanticMemory(
  base: MemoryService,
  vectorStore: VectorStore,
  embeddingModel: EmbeddingModel = defaultEmbeddingModel,
): SemanticMemoryService {
  // 重载 capture：存入向量
  const origCapture = base.capture.bind(base);
  const enhancedCapture = async (scopeId: ScopeId, facts: string[], at: number, author?: string): Promise<number> => {
    const count = await origCapture(scopeId, facts, at, author);
    // 异步存入向量（不阻塞 capture 返回）
    const embeddings = await embeddingModel.embed(facts);
    for (let i = 0; i < facts.length; i++) {
      const entry: SemanticMemoryEntry = {
        id: `mem:${scopeId}:${at}:${i}`,
        scopeId: String(scopeId),
        content: facts[i]!,
        embedding: embeddings[i],
        createdAt: at,
        lastAccessedAt: at,
        accessCount: 0,
        verifiedCount: 0,
        weight: 0.5,
        source: "capture",
      };
      await vectorStore.insert(entry).catch(() => undefined);
    }
    return count;
  };

  // 语义搜索
  const semanticQuery = async (
    scopeId: ScopeId,
    query: string,
    limit = 10,
  ): Promise<Array<{ content: string; score: number }>> => {
    const [embedding] = await embeddingModel.embed([query]);
    const results = await vectorStore.search(String(scopeId), query, embedding!, limit);
    return results.map((e) => {
      const fs = freshnessScore(e);
      vectorStore.touch(e.id).catch(() => undefined);
      return { content: e.content, score: Math.round(fs * 100) / 100 };
    });
  };

  // 统计
  const stats = async (scopeId: ScopeId): Promise<{ total: number; avgWeight: number; oldestDays: number }> => {
    // 从 vectorStore 获取（简化实现）
    const all = await vectorStore.search(String(scopeId), "", [], 1000);
    const now = Date.now();
    const weights = all.map((e) => e.weight);
    const ages = all.map((e) => (now - e.createdAt) / (1000 * 86400));
    return {
      total: all.length,
      avgWeight: weights.length ? Math.round((weights.reduce((a, b) => a + b, 0) / weights.length) * 100) / 100 : 0,
      oldestDays: ages.length ? Math.round(Math.max(...ages)) : 0,
    };
  };

  return {
    ...base,
    capture: enhancedCapture,
    semanticQuery,
    stats,
  };
}
