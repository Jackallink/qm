/**
 * 真实嵌入模型 — all-MiniLM-L6-v2 本地 adapter。
 *
 * 替换 semantic-memory.ts 中的 hash-based placeholder。
 * 用法：
 *   import { sentenceTransformerEmbedding } from "./real-embedding.ts";
 *   const svc = createSemanticMemory(base, vs, sentenceTransformerEmbedding);
 *
 * 本地运行需要：
 *   pip install sentence-transformers
 *   或使用 Docker 容器提供 embedding API
 *
 * 生产环境可替换为：
 *   - text-embedding-3-small (OpenAI API)
 *   - deepseek embedding API
 *   - 自建 embedding 服务
 */

import type { EmbeddingModel } from "./semantic-memory.ts";

/** 调用本地 Python sentence-transformers 做嵌入 */
export const sentenceTransformerEmbedding: EmbeddingModel = {
  async embed(texts: string[]): Promise<number[][]> {
    // 方式 A：通过 Python 子进程（需要 pip install sentence-transformers）
    const { spawnSync } = await import("node:child_process");
    const input = JSON.stringify(texts);
    const result = spawnSync("python3", ["-c", `
import json, sys
try:
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer('all-MiniLM-L6-v2')
    embeddings = model.encode(json.loads(sys.stdin.read()))
    print(json.dumps([e.tolist() for e in embeddings]))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`], { input, encoding: "utf8", timeout: 30_000 });

    if (result.error) {
      // Fallback to hash-based if real model unavailable
      const { hashEmbedding } = await import("./semantic-memory.ts");
      return texts.map((t) => hashEmbedding(t, 384));
    }

    try {
      const parsed = JSON.parse(result.stdout.trim());
      if (parsed.error) {
        const { hashEmbedding } = await import("./semantic-memory.ts");
        return texts.map((t) => hashEmbedding(t, 384));
      }
      return parsed as number[][];
    } catch {
      const { hashEmbedding } = await import("./semantic-memory.ts");
      return texts.map((t) => hashEmbedding(t, 384));
    }
  },
};
