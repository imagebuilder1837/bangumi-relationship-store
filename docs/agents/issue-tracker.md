# Issue tracker: GitHub

本模块工单与待实施规格使用 `imagebuilder1837/bangumi-relationship-store` 的 GitHub Issues，通过 gh CLI 操作。
`gh issue` 命令显式指定 `--repo imagebuilder1837/bangumi-relationship-store`；`gh api` 使用该仓库路径，避免误操作宿主仓库。

- 读取：`gh issue view <number> --repo imagebuilder1837/bangumi-relationship-store --json number,title,body,labels,comments`。
- 发布规格时创建 Issue；获取 ticket 时读取对应 Issue。

## Pull requests as a triage surface

**PRs as a request surface: no.**

## 父子工单与依赖

优先使用 GitHub 原生 sub-issues 和 issue dependencies。
无法使用时，以父工单任务列表及子工单的 `Part of`、`Blocked by` 链接表达。

## Wayfinder

- Map：带 `wayfinder:map` 标签的 Issue，承载 Notes、Decisions-so-far 和 Fog。
- 子工单：关联 Map，使用 `wayfinder:<type>` 标签；type 为 research、prototype、grilling 或 task。
- Frontier：按 Map 顺序选择未关闭、无未关闭阻塞项且无人认领的子工单。
- 认领：将对应子工单指派给执行者。
- 完成：在对应工单记录结论并关闭，再更新 Map 的决策摘要和链接。
