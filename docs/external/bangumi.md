# 关系观察与浏览器存储的证据边界

以下原站样本沿用二度好友组件已有调查，不是本次重新抓取。

## 原站异常

- **浏览器登录态补充实测**：`shironegi` 的好友中，`616197`、`1041797`、`1208024`、`1097234`、`1189298`、`1260050` 的主页身份匹配、显示名为 `[已注销]`，但 friends 返回 HTTP 200、最终 URL 不变，正文仅含 `#colunmNotice` 错误主体：`h2` 为“呜咕，出错了”、`p.text` 为“啊噢，你访问的页面似乎被 Bangumi 娘吃掉了。”、图片为 `/img/bangumi/404.png`，无身份头和列表；不使用缓存重新请求仍如此。`616197/rev_friends` 同样返回该错误页。错误页不能证明零关系或具体账号状态。
- **反例**：同样显示名为 `[已注销]` 的 `yuri_chan` 的 friends 返回合法空列表，rev_friends 返回 167 条关系；`aguamalas`、`763761`、`e911` 的 friends 也可正常解析。不能仅凭显示名推断列表不可访问。
- **浏览器缓存响应重放实测**：`venusxx/friends` 返回 HTTP 200、570 个标准用户条目，其中一项的链接为 `/user/`、昵称为空、头像背景指向 `//lain.bgm.tv/pic/user/l/`。仅移除该项后，其余 569 位用户通过现有身份及列表校验；无法从该条目恢复用户标识或判断具体账号状态。

未验证账号真实注销/封禁状态；以上不支持由异常推断真实账号状态。协议的识别条件见 [行为规格](../spec.md#观察与原站异常)。

## 浏览器本地存储与写入协调

以下为 IndexedDB 标准与浏览器厂商资料，不是 Bangumi 服务器行为；未进行真实浏览器、多标签页、容量或断电恢复实测。

- **标准：事务原子性**：[W3C IndexedDB §2.7.1](https://www.w3.org/TR/IndexedDB/#transaction-lifecycle)规定提交时全部更改原子写入，发生磁盘写入等错误则不写入任何更改；[中止算法 §5.5](https://www.w3.org/TR/IndexedDB/#abort-transaction)撤销该事务对数据库的全部更改。单个请求成功不等于事务提交成功；事务成功提交后才触发 `complete`。
- **标准：并发与排队**：同一数据库可由多个页面／worker 同时使用（[W3C IndexedDB 示例说明](https://www.w3.org/TR/IndexedDB/#handling-versionchange)）；[§2.7.2](https://www.w3.org/TR/IndexedDB/#transaction-scheduling)要求 `readwrite` 事务等待更早创建、作用域重叠且未结束的事务。作用域按 object store 判断，不按记录 key；重叠的只读事务可以并行。此为数据库事务调度保证，不是任意异步读写流程的全局锁。
- **标准及解释：隔离范围**：[W3C IndexedDB §2.1](https://www.w3.org/TR/IndexedDB/#database-construct)以 storage key 划分数据库集合，数据库名只在该 key 内标识数据库；[Storage Standard §4.2](https://storage.spec.whatwg.org/#storage-keys)以 origin 定义 key，并注明存储分区模型可能扩展。因此同名数据库不跨不同主机共享，也不能据同源推定不同浏览器配置或隔离分区必然共享；禁用存储时获取 key 可失败。
- **标准／厂商资料：容量与保留边界**：[Storage Standard §6–7](https://storage.spec.whatwg.org/#usage-and-quota)将用量与配额定义为实现相关估计，存储压力下可清理默认的 `best-effort` 存储；[WebKit 存储政策](https://webkit.org/blog/14403/updates-to-storage-policy/)确认 IndexedDB 受配额与清理政策约束，配额上限不保证可实际写满，写入可能报 `QuotaExceededError`。获准的 `persistent` 模式限制浏览器自动清理，不阻止用户清除；[IndexedDB durability hint](https://www.w3.org/TR/IndexedDB/#transaction-durability-hint)还区分默认、宽松与严格落盘语义。因此事务完成不承诺固定容量、永久保留或断电后必定恢复。
- **标准：版本升级阻塞**：[W3C IndexedDB 打开连接算法 §5.1](https://www.w3.org/TR/IndexedDB/#open-a-database-connection)要求升级前通知旧连接 `versionchange`，等待这些连接关闭；通知后仍有未关闭连接时触发 `blocked`。此事件表示升级等待其他连接，不是一般写事务的排队通知。
