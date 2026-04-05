# VPN 稳定度检测 Demo 说明

## 1. 脚本位置

- Demo 脚本：
  `/Users/yunshu/Documents/trae_projects/skills/skill-manager/scripts/network/runVpnDiagnosticsDemo.js`

## 2. 当前脚本做了什么

这个脚本是一个命令行 Demo，用来快速验证“VPN 稳定度检测”这个功能方向是否成立。

当前能力包括：

- 定时采样公网 IPv4
- 检测 OpenAI API 连通性
- 检测 Anthropic API 连通性
- 输出聚合后的稳定度结论

当前脚本是为了验证检测逻辑，所以每轮采样都会顺带测一次 OpenAI / Anthropic。

注意：

- 这适合做短时 Demo
- 不建议直接照搬成正式产品策略
- 正式页面版建议改成“公网 IP 自动检测，API / TLS 手动触发”

## 3. 运行方式

在项目目录下执行：

```bash
node scripts/network/runVpnDiagnosticsDemo.js --duration=20 --interval=5
```

参数说明：

- `--duration`
  总检测时长，单位秒
- `--interval`
  采样间隔，单位秒

示例：

```bash
node scripts/network/runVpnDiagnosticsDemo.js --duration=180 --interval=10
```

表示：

- 总共运行 180 秒
- 每 10 秒采样一次

## 4. 当前输出内容

脚本每轮会输出一行：

```text
[1/5] 2026-04-05T02:55:16.794Z | IP=128.242.105.235 | OpenAI API:401 | Anthropic API:405
```

含义：

- 当前是第几轮采样
- 采样时间
- 本轮检测到的公网 IP
- OpenAI API 的 HTTP 结果
- Anthropic API 的 HTTP 结果

结束后会输出汇总报告，包含：

- 采样区间
- 总采样次数
- 公网 IP 是否稳定
- 每个 IP 出现了多少次
- OpenAI API 平均 DNS / TLS / HTTP 耗时
- Anthropic API 平均 DNS / TLS / HTTP 耗时
- 综合结论

## 5. 状态码怎么理解

这个 Demo 不是在验证“账号能不能正常调用模型”，而是在验证“网络链路有没有到达目标服务”。

所以这里的判断标准是：

- OpenAI 返回 `401`
  视为“已连到 OpenAI API”
- Anthropic 返回 `405`
  视为“已连到 Anthropic API”

这些都不代表失败，只代表：

- DNS 成功
- TCP/TLS 成功
- HTTPS 请求到达服务端
- 只是请求方式或鉴权不满足正式调用条件

## 6. 页面版建议交互

正式页面建议不要完全照抄当前脚本行为，而是拆成 3 类能力：

### 自动触发

- `公网 IP 检测`

建议：

- 用户进入页面后自动开始
- 默认每 5 到 10 秒采样一次
- 只负责判断出口 IP 是否切换

### 手动触发

- `API 连通性检测`
- `TLS 握手检测`

建议：

- 用户主动点击按钮才执行
- 不默认高频自动跑
- 避免频繁请求 OpenAI / Anthropic 端点

## 7. 推荐页面结构

第一版页面可以按下面 3 块来做：

### A. 公网 IP 稳定度卡片

展示内容建议：

- 当前公网 IP
- 最近一次更新时间
- 已采样次数
- 唯一 IP 数量
- 是否发生切换
- 3 分钟 / 10 分钟检测状态

### B. API 连通性卡片

展示内容建议：

- `检测 OpenAI`
- `检测 Anthropic`
- 最近一次结果
- 最近一次状态码
- 最近一次耗时
- 错误原因

这个卡片建议带按钮：

- `立即检测`

### C. TLS 即时诊断卡片

展示内容建议：

- 域名输入或预设目标
- `立即握手检测`
- 是否握手成功
- TLS 耗时
- 错误信息

## 8. 当前这轮 Demo 实测结果

执行命令：

```bash
node scripts/network/runVpnDiagnosticsDemo.js --duration=20 --interval=5
```

本次结果：

- 采样区间：
  `2026-04-05T02:55:14.731Z -> 2026-04-05T02:55:45.802Z`
- 共 `5` 次采样
- 公网 IP：
  `128.242.105.235`
- IP 结果：
  `5/5` 成功，且没有切换
- OpenAI API：
  `5/5` 可达，最近状态码 `401`
- Anthropic API：
  `5/5` 可达，最近状态码 `405`

综合结论：

> 公网 IP 稳定，OpenAI / Anthropic API 握手均成功，当前未发现短时波动。

## 9. 你做页面时可以直接采用的产品口径

推荐直接按下面这句话来理解功能边界：

- `公网 IP 自动检测`
  用来判断 VPN 出口是否稳定
- `API 连通性手动检测`
  用来判断目标 AI 服务能不能到
- `TLS 手动检测`
  用来判断更底层的网络握手是否正常

这样可以避免：

- 自动高频打 API
- 用户误以为 `401/405` 是失败
- 页面逻辑混在一起

## 10. 后续如果进入正式实现

建议把当前 Demo 拆成两部分：

- `IP 自动检测服务`
  专门负责定时采样和聚合
- `手动诊断服务`
  专门负责 API / TLS 即时检测

这样页面层只负责展示，不直接承担复杂网络逻辑。
