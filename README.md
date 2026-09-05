# Ashes of Pantheon QA Tool

面向《Ashes of Pantheon》的桌面 QA 工作台。前端使用 Electron、Vue 3、Tailwind CSS 4 与 GSAP。

## 当前能力

- 卡牌目录：图片列表、名称、TypeId、描述、1 秒 hover 提示、多选筛选与排序、离线缓存。
- 战斗工作台：动态格网、玩家/怪物/装备位置、对象检查器、装备按格放置。
- 玩家：生命、费用、异常值模式、祝福增删。
- BUFF：对玩家或怪物添加和移除 BUFF。
- 怪物：生命、攻击力、已注册意图序列、循环起点与参数编辑。
- Editor Bridge：由工具安装到用户选择的 Unity 项目；Edit Mode 提供真实卡牌目录，Play Mode 额外提供战斗状态与修改能力，且不会进入 Player 构建。
- 游戏包识别：检测 Windows Unity 包及 Mono/IL2CPP 后端。
- 应用更新：便携版从 GitHub Releases 检查正式版本，并在浏览器中打开新版便携文件供手动替换。

打包游戏的临时加载器将在取得实际游戏包后完成适配。原始游戏包不会被修改。

## 本地运行

```powershell
pnpm install
pnpm run dev
```

只预览 renderer：

```powershell
pnpm run dev:web
```

## 验证

```powershell
pnpm run typecheck
pnpm test
pnpm run test:e2e
pnpm run build
```

项目内置的 Unity Package 位于 `resources/unity-package/com.ashes-of-pantheon.qa-bridge`。不要手工提交到游戏项目；通过工具的“项目与连接”页面安装或卸载。

## 发布更新

开发模式不会访问更新源。便携版可以在“项目与连接”页面打开 GitHub Release 下载最新版；下载完成后关闭旧版本，直接运行新的便携版文件，不需要安装。

发布新版本时先更新 `package.json` 的 `version`，提交后创建同版本 `v*` 标签，例如：

```powershell
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions 会运行测试、构建单文件 Windows 便携版，并把便携版 `.exe` 发布到 GitHub Releases。标签必须与 `package.json` 版本一致。
