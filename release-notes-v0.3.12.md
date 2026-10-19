# opencode2dsh v0.3.12

## 更新

- **免费通道从「几乎必定 403」恢复到可用（[#62](https://github.com/FishBottle7/opencode2dsh/issues/62)）。** 从 2026-10-13 前后起，匿名免费通道的请求开始大面积返回 `API 密钥无效` / `403 FreeTierError`，换模型、换客户端都无效，issue 里多人报告。根因不在密钥也不在模型：适配器合成的 `ses_` 会话 id **形状**一直合法，但 12 位十六进制字段的**来源**错了 —— 上游把这个字段解开成「时钟 × 4096 + 每毫秒计数器」，只接受计数器落在 `[0, 63]` 的取值；旧实现填的是 `sha256` 摘要字节，只有约 **1.5%** 的会话碰巧落进窗口，于是看起来像「全挂」。现在该字段改由上游自己的生成器公式产出（`~(Date.now()*0x1000 + 1)`，计数器固定为 1），会话身份仍折叠进 14 位 Base62 尾巴，因此不同会话不会撞车、prompt cache 亲和性保留，真实 OpenCode 客户端传来的 `ses_` id 依旧原样透传。会话按对话记忆化，重试与后续轮次复用同一个 id（这也是推理降级重发路径的既有契约）。
- **上游限制类错误不再伪装成「密钥无效」。** 若通道再次因上游策略收紧而拒绝，错误会保留原始说明并归类为 `FREE_TIER_RESTRICTED`，而不是报「API 密钥无效」误导排查方向；该类失败不重试。
- **模型选择器会跟随目录变化刷新（[#59](https://github.com/FishBottle7/opencode2dsh/issues/59)）。** 启动 4 秒窗口之后才到达的 Zen 响应也能触发刷新。冷启动抓取失败时目录以 `error` 状态暴露为空，而已有内容的目录刷新失败则保留上一次的模型名单并标记 `stale`，不再直接清空。
- **订阅链接的保存与刷新行为修复（[#60](https://github.com/FishBottle7/opencode2dsh/issues/60)、[#63](https://github.com/FishBottle7/opencode2dsh/issues/63)）。** 「立即刷新」按钮现在真正走 `scope: 'subscriptions'`，会等待进行中的轮次并显示进度与上游错误；清空 URL 或关闭 IP 池会停掉旧的抓取器。保存过的订阅 URL 能正确到达运行时，重开设置页依然可见（宿主与浏览器共用同一套嵌套/旧格式解析规则，并能处理 schema 注入的空数组）。订阅抓取的 User-Agent 可通过 `ipPool.subscription.userAgent` 配置，留空恢复 `clash-verge/v2.0`。

## 验证

- TypeScript 检查与 **296 项测试**通过（基线 263，本次累计新增 33 项）。
- **真实链路 A/B（2026-10-13，无代理直连）**：同一 URL / header / body / UA，只替换 12 位十六进制字段 —— 旧摘要前缀 **403 FreeTierError**（3/3），上游生成器公式 **200 并正常出文本**（3/3）。
- **真实链路端到端**（插件自身 `ZenAdapter.stream()` + 真实网络）：修复前 `mimo-v2.6-flash-free` **0/3** 全部 403，修复后 **3/3** 正常 `stop` 出文本；合并后 master 上复验同样 **3/3** 通过。
- **门禁边界实测**（两个免费模型、重复两次，结果稳定）：`counter=1/16/32/63` 接受，`counter=64/128/255/300` 拒绝，边界精确在 63|64；高 36 位时钟字段**不参与校验** —— 把高位全置 0（解码成 1970-01-01）的 id 依然被接受。这条结论修正了修复 PR 原本「上游核对合理墙钟」的推断，也解释了为什么照 `ffe` 结尾硬编码碰巧能过、但并不是因为在匹配哨兵。

## 贡献

感谢 [GT-610](https://github.com/GT-610) 的 [#65](https://github.com/FishBottle7/opencode2dsh/pull/65)：定位到 `ses_` id 的 12 位十六进制来自上游生成器公式，并保留了会话记忆化以维持重试与缓存亲和性 —— 这是本次修复的核心，已原样合并。感谢 [BobJu0721](https://github.com/BobJu0721) 的 [#67](https://github.com/FishBottle7/opencode2dsh/pull/67)：其方案与 #65 数学等价，同样正确，因 #65 先合并而关闭，其中的 memo 键思路留作后续参考。

## 升级

需要 DSH 0.1.7 或更高版本。web profile 可执行：

```sh
dsh plugin --profile web add @opencode2dsh/dsh-plugin@0.3.12
```

安装后重启 DSH。
