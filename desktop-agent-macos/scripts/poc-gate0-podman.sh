#!/usr/bin/env bash
# Gate 0/1/2 的 Podman PoC：Neo4j + Graphiti + CGC。
#
# 这是验证脚本，不是正式安装器。需要 Podman machine 已启动。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/thinkfusion-gate0"
mkdir -p "$WORK/neo4j-data" "$WORK/cgc-sample/src"

cat > "$WORK/cgc-sample/src/a.ts" <<'TS'
export function charge(id: string): number { return id.length; }
export class OrderService {
  processOrder(id: string): number { return charge(id); }
}
TS
cat > "$WORK/cgc-sample/src/b.ts" <<'TS'
import { OrderService } from './a';
export function run(): number { return new OrderService().processOrder('x'); }
TS
cat > "$WORK/cgc-sample/src/OrderService.java" <<'JAVA'
package demo;
public class OrderService {
  public int processOrder(String id) { return charge(id); }
  private int charge(String id) { return id.length(); }
}
JAVA

echo '== CGC =='
podman run --rm -v "$WORK/cgc-sample:/work:Z" -w /work python:3.12-slim \
  bash -lc 'pip install -q codegraphcontext==0.6.13 && cgc index /work && cgc list && cgc analyze callers processOrder'

echo '== Neo4j =='
if ! podman container exists tf-neo4j; then
  podman run -d --name tf-neo4j -p 7474:7474 -p 7687:7687 \
    -e NEO4J_AUTH=neo4j/testpass \
    -v "$WORK/neo4j-data:/data" neo4j:5.26-community
fi
for i in $(seq 1 60); do
  podman exec tf-neo4j cypher-shell -u neo4j -p testpass 'RETURN 1' >/dev/null 2>&1 && break
  sleep 2
done
podman exec tf-neo4j cypher-shell -u neo4j -p testpass 'RETURN 1' >/dev/null

echo '== Graphiti =='
# Podman 的容器名 DNS 在默认 bridge 上不一定可用；用实际 IP 更稳。
NEO4J_IP="$(podman inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' tf-neo4j)"
podman run --rm --network podman \
  -e NEO4J_URI="bolt://${NEO4J_IP}:7687" -e NEO4J_USER=neo4j -e NEO4J_PASSWORD=testpass \
  -e OLLAMA_BASE=http://host.containers.internal:11434/v1 \
  -e OLLAMA_MODEL=gpt-oss:20b -e OLLAMA_EMBED=all-minilm -e STRUCTURED_MODE=json_schema \
  -v "$ROOT/scripts/poc-graphiti.py:/work/poc.py:Z" \
  python:3.12-slim bash -lc 'pip install -q "graphiti-core[neo4j]" && python /work/poc.py'
