# 关系快照存储协议

领域名称见 [术语表](../GLOSSARY.md)。本模块不请求原站、不判定任务完成，也不计算排名或路径。

## 接口

从 `src/index.mjs` 导入 `createRelationshipStore({ indexedDB })`，注入当前浏览器的 IDBFactory。返回 `read(query, { signal }?)` 和 `commit(batch, { signal }?)`；均为异步操作。

- query 的 `relationships` 为 `[用户标识, 方向]` 数组，`users` 为用户标识数组；两者可省略。方向仅为 `friends` 或 `rev_friends`。
- batch 的 `relationships` 为按用户标识、方向嵌套的快照字典，`users` 为按用户标识组织的展示信息字典；两者可省略。
- read 返回同样两层的 `relationships` 及 `users` 字典，省略未存储的键。缺少快照表示未知，不是空关系。返回值与存储隔离；修改返回值不修改数据库。
- 输入、快照和 issue 只接受本协议声明的字段；commit 在打开数据库前验证并复制整个批次。非法成员、方向、时间、状态或资料导致整批拒绝。成员去重，保留首次出现的顺序。

```js
const store = createRelationshipStore({ indexedDB: window.indexedDB });
await store.commit({
  relationships: {
    alice: {
      friends: { status: "available", members: ["bob"], fetchedAt: Date.now() },
    },
  },
});
const data = await store.read({ relationships: [["alice", "friends"]] });
```

## 观察与原站异常

`fetchedAt` 是生产者取得本次观察时的 Unix 毫秒时间，必须为非负、有限且不超过 JavaScript 日期范围的数值。它不表示原站修改时间。用户标识为非空字符串，不推测 username 与 UID 的映射。

| 状态 | 字段 | 含义 |
| --- | --- | --- |
| `available` | `members: string[]`, `fetchedAt` | 已读取的有效成员；`[]` 是明确空集合 |
| `available`，附 issue | 上述字段及 `issue: { code: "missing-identifiers", count: 正安全整数 }` | 保留有效成员，但有无法识别的条目 |
| `unavailable` | `fetchedAt`, `issue: { code: "deleted-display-name-page-unavailable" }`，无 members | 符合以下已识别条件，未取得列表 |

异常代码是生产者对识别条件的声明，不是模块再次校验 HTML 的结果：

- `missing-identifiers`：请求成功且最终 URL 未变；页面身份匹配目标用户、列表和标准条目结构合法、头像背景 URL 非空；该条目的用户链接同源、路径精确为 `/user/` 且无查询或片段。count 为这类条目数。其他损坏不归入此类。
- `deleted-display-name-page-unavailable`：已观察到目标用户显示名精确为 `[已注销]`；关系请求成功且最终 URL 未变；页面没有 `#headerProfile` 和 `#memberUserList`；`#colunmNotice` 中首个 h2、p.text 去除首尾空白后分别为“呜咕，出错了”“啊噢，你访问的页面似乎被 Bangumi 娘吃掉了。”，并含 `img[src="/img/bangumi/404.png"]`。

两类状态都不证明账号真实注销。普通网络、HTTP、身份或解析失败不生成快照，不以空集合替代；已接受的异常不由旧成员补齐。原站证据及其边界见 [外部调查](external/bangumi.md)。

用户展示信息为 `{ name: string, avatar: string, fetchedAt }`，avatar 为空或 HTTP(S) 地址。它不决定身份，也不决定关系快照是否存在。展示信息未知时由消费者选择回退显示。

## 覆盖与一致性

- 每个用户、方向只保留一份观察；本次提交完整覆盖成员和异常，不作集合并集。正常、部分缺失、不可访问使用同一规则；用户展示信息同样覆盖。
- commit 不读取旧记录、不比较观察时间，按成功写事务顺序覆盖；fetchedAt 仍表示观察时间，不表示优先级。去重与提交节奏由消费者决定。
- 一次 read 在一个只读事务内完成；多次 read 可以组合不同提交的观察，不保证整图或整个算法运行的统一视图。
- 一次 commit 在同一个读写事务中直接写入指定记录；本批所有快照和资料整体成功或回滚。只在事务 complete 后返回成功。
- 事务完成前取消可回滚；完成后取消不能撤销提交。打开期间取消立即拒绝并清理晚到连接。取消以 signal.reason 拒绝。
- 快照不按年龄过期，不留历史，不推导反方向完整列表，不缓存任务状态或最终结果，不通知其他页面自动刷新。

## 数据库与版本

同一浏览器存储分区及 origin 使用 `bangumi-relationship-store` 数据库，IndexedDB 版本为 1。不同主机、浏览器配置及隔离分区不承诺共享。模块无旧库读取、迁移或删除操作。

- `relationships`：无 keyPath、自增或索引，以 `[用户标识, 方向]` 为键。
- `users`：无 keyPath、自增或索引，以用户标识为键。
- 每条记录为 `{ version: 1, value: 快照或展示信息 }`。数据库与记录格式保持版本 1，新旧组件可互读；旧模块可能按观察时间比较，新模块直接覆盖，不承诺新旧模块行为一致。未来不兼容的记录格式须升级协议并定义迁移。
- 新建数据库时创建结构；已有结构缺失或未知数据库版本拒绝操作，不重建或清库。read 校验指定记录，拒绝损坏或未知记录版本；commit 不检查被覆盖记录，因此可覆盖其损坏或未知版本内容。不相关记录损坏不阻止访问其他键。

每次调用只访问指定键并关闭连接；事务作用域包含两个 store，写事务仍受 object-store 级调度约束，不是行级锁。所需空间与时间随本批记录及成员数量增长，仍受浏览器容量、清理和持久性限制。

## 错误

除取消外，使用 `RelationshipStoreError.code` 判断，不解析英文 message；底层错误保留为 cause，可能保留其 name。

| code | 含义 |
| --- | --- |
| `invalid-input` | 调用参数非法，整批拒绝 |
| `corrupt-data` | 当前结构损坏，或读取的记录损坏；操作拒绝 |
| `incompatible-version` | 不支持的数据库版本，或读取到未知记录版本 |
| `unavailable` | IndexedDB 缺失或权限、状态不允许访问 |
| `quota-exceeded` | 容量不足，写入回滚 |
| `blocked` | 打开/升级被其他连接阻塞，放弃本次操作并清理晚到连接 |
| `storage-error` | 其他数据库错误 |

消费者负责文案及是否降级为实时读取。协议不提供独立的自动修复、清库或迁移操作；显式提交只覆盖调用方指定的键。
