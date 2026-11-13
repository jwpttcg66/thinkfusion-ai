# Gate 0 Benchmark：5 个工程问题

- 工程：`/Users/yalla/data/codeStudy/grpc-springboot`
- 版本：基线 `5b2e56e`
- 用途：Gate 0 / Gate 2 的初始基准；**harness 结果不能标成产品结果**。
- 载体：`scripts/spikes/agentic-search-real.cjs`（独立只读 harness）或后续正式 Agentic Search。
- 评分：文件、符号、行号、证据引用、反例、成本，六项分开记录。

## Q1 配置定位

**问题**：gRPC 服务端监听哪个端口？客户端目标地址来自哪里？

**预期文件**

- `src/main/resources/application.yml`

**预期符号 / 行号**

- `grpc.server.port`：`application.yml:5-7`
- `grpc.client.local-grpc-server.address`：`application.yml:8-11`
- `negotiation-type: plaintext`：`application.yml:11`

**预期结论**

- 服务端端口 `50071`；
- 客户端地址 `static://localhost:${grpc.server.port}`，解析为 `static://localhost:50071`；
- 明文连接。

**错误答案示例**

- 说端口来自 `GreeterClient` 代码；
- 说地址是硬编码的 `50071` 字符串；
- 说使用 TLS。

## Q2 启动流程

**问题**：这个 Spring Boot + gRPC 工程的启动入口是什么？gRPC server 由谁启动？

**预期文件**

- `src/main/java/com/example/grpcspringboot/GrpcSpringbootApplication.java`
- `pom.xml`

**预期符号 / 行号**

- `@SpringBootApplication`：`GrpcSpringbootApplication.java:6-7`
- `SpringApplication.run(...)`：`GrpcSpringbootApplication.java:9-11`
- `net.devh:grpc-server-spring-boot-starter`：`pom.xml` 依赖段

**预期结论**

- 进程入口是 `GrpcSpringbootApplication`；
- 没有手写 `ServerBuilder`/`addService`；
- gRPC server 由 `net.devh` starter 自动装配。

**错误答案示例**

- 把 `GreeterGrpcService` 说成进程入口；
- 声称有手写 `ServerBuilder`；
- 声称需要单独运行 gRPC server main。

## Q3 跨文件调用

**问题**：`GreeterClient` 如何发起一次 `sayHello` 调用？经过哪些类型？

**预期文件**

- `src/main/java/com/example/grpcspringboot/client/GreeterClient.java`
- `src/main/java/com/example/grpcspringboot/hello/GreeterGrpc.java`（生成代码）
- `src/main/java/com/example/grpcspringboot/hello/HelloRequest.java`（生成代码）
- `src/main/java/com/example/grpcspringboot/hello/HelloReply.java`（生成代码）

**预期符号 / 行号**

- `@GrpcClient("local-grpc-server")`：`GreeterClient.java:12`
- `GreeterGrpc.GreeterBlockingStub` 字段：`GreeterClient.java:12-13`
- `greeterBlockingStub.sayHello(...)`：`GreeterClient.java:15-19`
- `HelloRequest.newBuilder().setName(...)`：`GreeterClient.java:16-18`

**预期结论**

- Spring 注入 blocking stub；
- 调用 `sayHello(HelloRequest)`，返回 `HelloReply`；
- 连接参数来自 `@GrpcClient` 名称对应的配置。

**错误答案示例**

- 声称 `GreeterClient` 手写 `ManagedChannel`；
- 声称调用了 `UserRepository`/数据库；
- 把 `GreeterGrpcService` 和 `GreeterClient` 混为一个类。

## Q4 业务流程

**问题**：`ClientRunner` 在什么条件下会触发客户端调用？调用链是什么？

**预期文件**

- `src/main/java/com/example/grpcspringboot/runner/ClientRunner.java`
- `src/main/resources/application.yml`

**预期符号 / 行号**

- `@ConditionalOnProperty(prefix="demo.client", name="run-on-startup", havingValue="true")`：`ClientRunner.java:11-13`
- `implements ApplicationRunner`：`ClientRunner.java:13`
- `run(ApplicationArguments args)`：`ClientRunner.java:24-25`
- `greeterClient.sayHello(name)`：`ClientRunner.java:29-31`
- `demo.client.run-on-startup: false`：`application.yml:15`

**预期结论**

- 只有 `demo.client.run-on-startup=true` 时 Bean 才创建；
- 默认 `false`，不会自动执行；
- 启动完成后由 `ApplicationRunner` 回调执行；
- 失败重试最多 10 次、间隔 500ms。

**错误答案示例**

- 声称默认自动执行；
- 只说 `@Component`，漏掉 `@ConditionalOnProperty`；
- 把 `run-on-startup` 说成服务端端口配置。

## Q5 反向验证

**问题**：这个工程里是否所有 gRPC 服务方法都真正实现了？有没有只声明未实现、或没有注册的服务？

**预期文件**

- `src/main/proto/hello.proto`
- `src/main/java/com/example/grpcspringboot/service/GreeterGrpcService.java`
- `src/main/java/com/example/grpcspringboot/hello/GreeterGrpc.java`（生成代码）

**预期结论**

- `hello.proto` 只声明一个 `Greeter` 服务、一个 `SayHello` RPC；
- `GreeterGrpcService` 实现了 `sayHello`；
- 没有发现第二个未实现的服务；
- 生成代码不算手写实现，不能把生成类当成业务实现。

**错误答案示例**

- 把生成代码 `GreeterGrpc` 当成业务实现；
- 声称存在多个未实现 RPC；
- 把 `HelloRequest`/`HelloReply` 当成服务实现。

## 运行记录格式

每次运行必须记录：

```json
{
  "questionId": "Q1",
  "carrier": "harness",
  "project": "codeStudy/grpc-springboot",
  "commit": "5b2e56e",
  "model": "gpt-oss:20b",
  "expectedFiles": [],
  "expectedSymbols": [],
  "expectedLines": [],
  "foundFiles": [],
  "foundSymbols": [],
  "citationAccuracy": 0,
  "missingEvidence": [],
  "fabricatedCitations": [],
  "toolCalls": 0,
  "tokens": 0,
  "durationMs": 0,
  "degraded": false,
  "verdict": "PASS"
}
```

`verdict` 只能是 `PASS` / `FAIL` / `SKIP`；`SKIP` 不能算通过。
