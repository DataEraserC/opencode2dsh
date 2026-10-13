# opencode2dsh v0.3.11

## 更新

- **免费匿名通道在 ~2026-10-09 上线的新门禁下恢复可用（[#56](https://github.com/FishBottle7/opencode2dsh/issues/56)）。** 对线上通道的消融探测（2026-10-11）定位真门禁为 **session 头里的 canonical `ses_*` id**(`x-opencode-session` / `x-session-affinity` / `X-Session-Id` 任一即可），而非 issue 报告推断的端点/凭证迁移——`/zen/v1` + `Bearer public` + 适配器本就在发的 canonical session 至今仍是 200,`/inference/openai` 反而会 401 这个 Bearer。真正挂掉的路径是 **IP 池准入 smoke 探针**（自建请求、没带伪装头），现已补齐完整 `disguiseHeaders`。同时按 issue 的体检矩阵落地两处目录修正:`FREE_LANE_BLOCKLIST` 屏蔽 5 个线上必死模型（`exo-free` 410 已下架、`jev-1.13-free` 400 协议不支持、`ling-3.0-flash-fin-free` 400 不可用、`muse-spark-1.*-contributor-free` 403 区域限制）,`list()` 与 `decision()` 双路生效;`LOCAL_MODEL_OVERRIDES` 修正 models.dev 把 `mimo-v2.6-flash-free` 上下文窗口错标为 200000（实为 1048576，与 MiMo 模型卡及官方 CLI 配置一致）。另预留 `GATE_TOOL_ALIASES` 别名缝，未来若门禁强制 `shell` 工具名可零成本启用。
- **冷启动显式思考强度不再被误拒（[#55](https://github.com/FishBottle7/opencode2dsh/issues/55)）。** models.dev 元数据抓取慢于 `warm()` 的 4s 窗口时（实测 23s),`resolveModel()` 的能力判定此前会看到空元数据表，宿主随即报 `UNSUPPORTED_REASONING_EFFORT`。`refreshMetadata()` 改为 stale-while-revalidate：在线抓取**之前**先加载新鲜磁盘缓存（< 7 天）作为能力基线，慢速抓取落地后覆盖；失败回退路径不变。

## 验证

- TypeScript 检查与 263 项测试通过；#55 新增"磁盘缓存在线、在线抓取挂起"的完整时序回归测试。
- 线上消融矩阵（2026-10-11，无代理直连）：无 session 头 403;canonical session 头任一拼写 200;`/zen/v1` + `Bearer public` 200;`/inference/openai` + Bearer 401;`bash`+`read` 旧工具配方 200;非流式 403。
- 真实链路端到端（插件自身 `ZenAdapter.stream()` + 真实网络）：纯聊天 + `reasoningEffort: low` 正常 `stop` 出文本；DSH 工具集强制工具调用正常 `tool-calls`；真实 `ModelCatalog`（live Zen + models.dev）暴露 8 个健康模型、5 个死模型被正确过滤。

## 贡献

感谢 [Mlte0907](https://github.com/Mlte0907) 的 #56 逆向报告（端点迁移线索、免费模型体检矩阵、models.dev 元数据疑点）——其中 blocklist 与 override 两项已原样采纳。

## 升级

需要 DSH 0.1.7 或更高版本。web profile 可执行：

```sh
dsh plugin --profile web add @opencode2dsh/dsh-plugin@0.3.11
```

安装后重启 DSH。
