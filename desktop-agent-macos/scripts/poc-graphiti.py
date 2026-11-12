"""Graphiti × Ollama × Neo4j 的最小 PoC，供 podman 容器调用。

不接 ThinkFusion 主进程；只验证 Gate 0/2 的链路：
- Neo4j 连接
- Ollama 结构化抽取
- Episode 写入
- 时间事实检索
"""
import asyncio
import os
from datetime import datetime, timezone

from graphiti_core import Graphiti
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
from graphiti_core.nodes import EpisodeType
from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://tf-neo4j:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "testpass")
OLLAMA = os.environ.get("OLLAMA_BASE", "http://host.containers.internal:11434/v1")
MODEL = os.environ.get("OLLAMA_MODEL", "gpt-oss:20b")
EMBED = os.environ.get("OLLAMA_EMBED", "all-minilm")
STRUCTURED = os.environ.get("STRUCTURED_MODE", "json_schema")


async def main() -> None:
    config = LLMConfig(api_key="ollama", model=MODEL, small_model=MODEL, base_url=OLLAMA)
    llm = OpenAIGenericClient(
        config=config,
        structured_output_mode=STRUCTURED,
    )
    graphiti = Graphiti(
        NEO4J_URI,
        NEO4J_USER,
        NEO4J_PASSWORD,
        llm_client=llm,
        embedder=OpenAIEmbedder(
            config=OpenAIEmbedderConfig(
                api_key="ollama",
                embedding_model=EMBED,
                embedding_dim=384,
                base_url=OLLAMA,
            )
        ),
        cross_encoder=OpenAIRerankerClient(client=llm, config=config),
    )
    await graphiti.build_indices_and_constraints()
    episodes = [
        ("订单服务曾出现重复扣款，修复要求 processOrder 必须幂等。", "历史问题"),
        ("2026-11 决策：订单重试使用幂等键，禁止重复扣款。", "架构决策"),
        ("OrderService.processOrder 必须在重试时返回同一结果。", "业务约束"),
    ]
    for index, (body, description) in enumerate(episodes):
        await graphiti.add_episode(
            name=f"gate0-{index}",
            episode_body=body,
            source=EpisodeType.text,
            source_description=description,
            reference_time=datetime.now(timezone.utc),
        )
        print(f"added episode {index}")
    results = await graphiti.search("订单重复扣款为什么必须幂等")
    for result in results[:10]:
        print("FACT", getattr(result, "fact", ""), "valid_at", getattr(result, "valid_at", None))
    await graphiti.close()


if __name__ == "__main__":
    asyncio.run(main())
