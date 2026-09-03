# Ashes of Pantheon QA Editor Bridge

该包只在 Unity Editor 中运行。Edit Mode 可导出卡牌目录，Play Mode 额外开放战斗状态与修改接口。程序集通过 `includePlatforms: ["Editor"]` 排除 Player 编译，不会进入 Development 或 Release 包。

QA 工具负责安装和卸载，不要将此目录提交到游戏项目的版本控制。
