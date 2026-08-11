/**
 * 内存向量存储 — 基于余弦相似度的轻量实现。
 *
 * 生产环境替换为 pgvector：
 *   CREATE EXTENSION vector;
 *   CREATE TABLE memory_embeddings (id, scope_id, content, embedding halfvec(256), ...);
 *   CREATE INDEX ON memory_embeddings USING ivfflat (embedding halfvec_cosine_ops);
 *
 * MVP 使用 JavaScript Set + 余弦相似度（256 维，<1000 条可接受）。
 */
import type { SemanticMemoryEntry, VectorStore } from "./semantic-memory.ts";

export function createMemoryVectorStore(): VectorStore {
  const store = new Map<string, SemanticMemoryEntry>();

  function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
    const den = Math.sqrt(na) * Math.sqrt(nb);
    return den > 0 ? dot / den : 0;
  }

  return {
    async insert(entry: SemanticMemoryEntry): Promise<void> {
      store.set(entry.id, entry);
    },

    async search(scopeId: string, _query: string, embedding: number[], limit = 10): Promise<SemanticMemoryEntry[]> {
      const candidates = [...store.values()]
        .filter((e) => e.scopeId === scopeId && e.embedding);
      const scored = candidates.map((e) => ({
        entry: e,
        score: cosineSimilarity(e.embedding!, embedding),
      }));
      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((s) => s.entry);
    },

    async touch(id: string): Promise<void> {
      const e = store.get(id);
      if (e) { e.lastAccessedAt = Date.now(); e.accessCount++; }
    },

    async reinforce(id: string, verified: boolean): Promise<void> {
      const e = store.get(id);
      if (e) { e.weight = Math.min(1.0, e.weight + 0.1); if (verified) e.verifiedCount++; }
    },

    async purgeExpired(scopeId: string, maxAgeDays: number): Promise<number> {
      const cutoff = Date.now() - maxAgeDays * 86400 * 1000;
      let count = 0;
      for (const [id, e] of store) {
        if (e.scopeId === scopeId && e.createdAt < cutoff && e.weight < 0.3) {
          store.delete(id); count++;
        }
      }
      return count;
    },
  };
}
