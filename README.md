# Ashes of Pantheon QA Tool

面向《Ashes of Pantheon》的桌面 QA 工作台。前端使用 Electron、Vue 3、daisyUI 5、Tailwind CSS 4 与 GSAP。

完整操作步骤见 [使用说明](docs/usage.md)。工具顶部问号打开在线说明，ZIP 根目录附带离线 `USAGE.md`。右下角操作提示仅显示一次，并在 2 秒后消失。

## 当前能力

- 卡牌目录：图片列表、名称、TypeId、描述、1 秒 hover 提示、多选筛选与排序、离线缓存。
- 战斗工作台：战斗地图、玩家/怪物/场上装备位置、对象检查器；装备下拉框支持中文名与 TypeId 搜索，放置成功后刷新列表和地图。
- 对象移位：在战斗地图长按对象 600 毫秒，进度完成后拖到目标格松开；支持主角、怪物和装备。也可选中对象后点击地图标题旁的移动按钮，再点目标格（方向键调整、Enter 确认）。Esc、窗口失焦、切页或拖出地图取消。只在玩家空闲阶段生效，不消耗移动力；越界、墙格、占用格及装备预留禁放格由游戏复核，忙碌或陈旧请求被拒绝。实际位置以 Bridge 返回快照为准。
- 主角检查器：在战斗中选择主角，通过“属性 / 祝福 / BUFF”选项卡编辑状态；不再设置独立玩家选项卡。桌面窗口最小为 1100 × 720，不提供手机端。
- BUFF：对玩家或怪物添加和移除 BUFF。
- 怪物：生命、攻击力、已注册意图序列、循环起点与参数编辑。
- Editor Bridge：由工具安装到用户选择的 Unity 项目；Edit Mode 提供真实卡牌目录，Play Mode 额外提供战斗状态与修改能力，且不会进入 Player 构建。
- 游戏包识别：检测 Windows Unity 包及 Mono/IL2CPP 后端。
- 应用更新：ZIP 便携版从 GitHub Releases 下载文件级增量更新，校验后由用户点击“重启并更新”；基础版本不匹配时回退完整 ZIP。

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

更新工具后，Editor 用户需要在连接页点击“更新 Bridge”并等待 Unity 编译；游戏包用户需先关闭临时游戏副本，重新安装打包版 Bridge，再从临时副本启动。原始游戏源文件不修改。名称优先读取游戏的 `zh-Hans` 本地化数据；本机项目中模板引用和对应中文表项均缺失的旧条目不能凭空恢复，例如 `TravelersBackpack`，需要核对实际游戏版本或补齐上游数据。

QA 自有 Bridge 的独立回归夹具和插件编译（不加载、构建或改写 Unity 项目）：

```powershell
./scripts/test-bridge.ps1 -UnityEditorPath 'D:\Unity Editor\2022.3.62f2c1\Editor'
./scripts/build-package-bridge.ps1 -UnityEditorPath 'D:\Unity Editor\2022.3.62f2c1\Editor'
```

## 发布更新

下载 Release 中的 `Ashes-of-Pantheon-QA-Tool-<版本>-win-x64.zip`，完整解压到可写目录后运行其中的 `Ashes of Pantheon QA Tool.exe`，不要从 ZIP 预览窗口直接运行，也不要只移动 EXE。没有安装器，不需要管理员权限。0.1.3 及更早的单文件版本需要手动迁移到 ZIP 一次，已保存的项目路径和目录缓存仍使用原用户数据目录。

正式 ZIP 版在“项目与连接”中检查更新、应用内下载、显示进度，并等待“重启并更新”。增量以文件为单位：未变的 Electron 运行文件不下载，改变的 `app.asar` 等文件整份下载。跨版本或本地基础文件不匹配时下载完整 ZIP；损坏的增量包也回退完整 ZIP。首个 ZIP 版本没有旧 ZIP 基础，后续发布自动生成相对上一正式 ZIP 版本的增量包。

仅替换发布清单拥有的文件；设置、缓存、用户自建文件、原始游戏均不删除。替换前保留备份，普通文件错误会恢复旧文件。断电或强制终止更新助手可能需要从用户数据目录 `zip-updates` 的备份恢复，或重新解压完整 ZIP；该目录的 `result.json` 记录结果。开发模式不访问更新源。更新需要 Windows PowerShell；安全策略禁止运行助手时工具不会退出，仍可手动解压更新。

发布新版本时先更新 `package.json` 的 `version`，提交后创建同版本 `v*` 标签，例如：

```powershell
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions 运行测试并构建 ZIP，发布完整 ZIP、`update.json` 和可用的 `.delta.zip`，不发布安装器或独立 EXE。标签必须与 `package.json` 版本一致。增量 ZIP 是供更新器使用的文件，不要手动解压覆盖。
