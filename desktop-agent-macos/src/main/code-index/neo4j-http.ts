/**
 * Neo4j HTTP 客户端：只走事务端点，不引 neo4j-driver。
 *
 * 用途是可选外部 Adapter（CGC / Graphiti）。不配置 URL 时完全不发请求，
 * 本地 SQLite 回退不受影响；请求失败只让外部通道降级，不影响文件读写。
 */

export interface Neo4jHttpOptions {
  baseUrl: string;
  user?: string;
  password?: string;
  database?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class Neo4jHttpClient {
  private readonly baseUrl: string;
  private readonly auth: string;
  private readonly database: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: Neo4jHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.database = options.database ?? 'neo4j';
    this.auth = 'Basic ' + Buffer.from(`${options.user ?? 'neo4j'}:${options.password ?? ''}`).toString('base64');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async query<T extends Record<string, unknown>>(
    statement: string,
    parameters: Record<string, unknown> = {}
  ): Promise<T[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/db/${this.database}/tx/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: this.auth },
        body: JSON.stringify({ statements: [{ statement, parameters }] }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Neo4j HTTP ${String(response.status)}`);
      const body = (await response.json()) as {
        results?: Array<{ data?: Array<{ row?: unknown[] }> }>;
        errors?: Array<{ message?: string }>;
      };
      if (body.errors && body.errors.length > 0) {
        throw new Error(body.errors.map(error => error.message ?? 'Neo4j error').join('; '));
      }
      return (body.results?.[0]?.data ?? [])
        .map(item => {
          const row = item.row ?? [];
          const out: Record<string, unknown> = {};
          // 这个 client 只给固定查询用；列顺序由调用方映射。
          row.forEach((value, index) => { out[`c${String(index)}`] = value; });
          return out as T;
        });
    } finally {
      clearTimeout(timer);
    }
  }
}
