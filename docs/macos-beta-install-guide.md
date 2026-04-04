# CodePal macOS 内测安装说明

## 适用场景

这份说明适用于未经过 Apple Developer 正式签名和公证的 CodePal 内测包。

当前内测包以 `dmg` 形式分发，测试用户可以正常安装和使用，但第一次打开前需要执行一条终端命令，移除 macOS 的隔离标记。

## 给测试用户的简版说明

你可以把下面这段直接发给测试同学：

```text
安装步骤：

1. 打开我发你的 DMG
2. 把 CodePal 拖到“应用程序”
3. 打开终端，复制执行：

xattr -dr com.apple.quarantine /Applications/CodePal.app && open /Applications/CodePal.app

第一次这样处理后，后面一般就可以正常打开了。
```

## 详细安装步骤

1. 双击打开 `CodePal-*.dmg`
2. 将 `CodePal.app` 拖到“应用程序”
3. 打开“终端”
4. 执行下面这条命令：

```bash
xattr -dr com.apple.quarantine /Applications/CodePal.app && open /Applications/CodePal.app
```

## 这条命令的作用

```bash
xattr -dr com.apple.quarantine /Applications/CodePal.app
```

作用：
- 移除 macOS 对测试版 App 的隔离标记
- 避免用户再去“系统设置 -> 隐私与安全性”里手动点“仍要打开”

```bash
open /Applications/CodePal.app
```

作用：
- 直接启动应用
- 让用户执行完命令后马上进入测试

## 常见问题

### 1. 为什么需要这一步？

因为当前内测包还没有 Apple Developer 正式签名和公证。

macOS 会把这类 App 识别为“来源未验证”，默认阻止直接打开。对内测阶段来说，这属于正常现象，不代表 App 本身有恶意行为。

### 2. 如果用户没有安装到“应用程序”怎么办？

把命令里的路径替换成真实路径即可。

例如安装在桌面：

```bash
xattr -dr com.apple.quarantine ~/Desktop/CodePal.app && open ~/Desktop/CodePal.app
```

### 3. 如果还是打不开怎么办？

先确认以下几项：

- App 名称是否真的是 `CodePal.app`
- App 是否确实已经拖入“应用程序”
- 命令里的路径是否和实际路径一致

如果不确定路径，可以让用户把 `CodePal.app` 直接拖进终端窗口，终端会自动补全路径，然后再在前面补上：

```bash
xattr -dr com.apple.quarantine 
```

以及在后面补上：

```bash
&& open 
```

## 对外说明建议

如果需要对外描述，可以统一使用下面这套说法：

- 当前版本为 macOS 内测版
- 首次启动前需要执行一条命令解除系统隔离标记
- 这是未签名测试版在 macOS 下的正常保护机制
- 后续正式版会接入开发者签名和公证，安装流程会更顺滑

## 公众号文案可用版本

下面这段可以作为公众号或群公告的基础文案：

```text
CodePal macOS 内测版安装说明

由于当前提供的是测试版本，还没有接入 Apple Developer 正式签名与公证，所以 macOS 第一次打开时会进行安全拦截。这是系统的正常保护机制。

安装方式如下：

1. 打开下载好的 DMG
2. 将 CodePal 拖到“应用程序”
3. 打开终端，执行以下命令：

xattr -dr com.apple.quarantine /Applications/CodePal.app && open /Applications/CodePal.app

完成后即可正常启动。后续正式版会接入签名和公证，安装体验会更完整。
```
