# pi-go 详细设计

状态：v0.1.0 初版已实现。需求依据：[requirements.md](requirements.md)，实际落地情况见第 14 节。

本文采用需求文档 Q1–Q9 的建议默认值，以形成可实现的完整方案；这些交互决策仍待确认。涉及 Pi API 的未验证路径明确列为技术验证项，不以设计推测替代可用性证明。

## 1. 架构

```text
启动参数 --g ── StartupAdapter ──┐
                                ├─ GoController
会话命令 /go ── CommandAdapter ──┘       │
                     ┌──────────────────┼──────────────────┐
                     ↓                  ↓                  ↓
               CatalogService      GoSelector         SessionGateway
                     │                  │                  │
              SessionRepository    ViewModel       Pi session replacement
                     │                  │
                     └──── MetadataStore ──────────────────┘
```

职责划分：

- 入口层：注册参数和命令、模式检查、启动一次性触发。
- GoController：等待空闲、加载数据、展示界面、解释动作、处理错误。
- CatalogService：将 session 与外部元数据归并为项目/会话目录。
- SessionRepository：通过 Pi 公共 session API 读取列表和元数据。
- MetadataStore：维护项目别名、pin、访问时间和额外目录。
- GoSelector：纯终端交互，不调用 session 替换 API。
- ViewModel：过滤、排序、选择、滚动和焦点状态。
- SessionGateway：封装恢复、创建和切换结果，隔离 Pi 版本差异。

UI 与环境变更必须分离。界面返回一个动作，然后在合法的命令上下文中执行；不要在组件按键处理函数内直接切换 session。

## 2. Pi 集成与已知限制

参考本机安装：`@earendil-works/pi-coding-agent` 1.1.0。

### 2.1 已核对的能力

- `pi.registerFlag()` 支持 boolean/string 扩展长参数，没有 short alias 字段。
- `pi.getFlag()` 读取扩展参数值。
- `pi.registerCommand()` 的 handler 获得 `ExtensionCommandContext`。
- 命令上下文提供 `waitForIdle()`、`switchSession()`、`newSession()`。
- `ctx.ui.custom()` 可构建交互界面。
- `ctx.mode === "tui"` 用于限制自定义终端界面。
- `switchSession()` 的底层运行时从目标 session 读取 cwd，并重新创建 cwd 相关运行环境。
- 公开的命令上下文 `newSession()` 未提供 cwd 参数，只能直接创建当前目录 session。
- session 替换后旧上下文失效；后续 session 相关工作应使用 `withSession` 回调提供的新上下文。

不要导入 Pi 内部 runtime 对象作为常规实现依赖。实现前必须重新核对公共导出和当前版本行为。

### 2.2 启动入口

注册 boolean 参数 `g`。扩展 factory 仅注册能力，不启动 UI。

建议状态：

```text
not-requested | pending | dispatched | completed
```

在首次 `session_start` 中检测交互模式与参数，进入 pending，并在派发前标记 dispatched，避免 session 切换触发事件后重复打开。

重要约束：`session_start` 不具备命令上下文，不能在事件回调中等待执行命令专用 session 替换操作。

实现前验证一种官方支持的命令派发桥接方式：例如将 `/go` 排入交互命令路径，但必须确认 Pi 的发送接口确实会分派 slash command、不会将其发给模型，且不会与正在处理的生命周期形成互相等待。未经验证不指定具体发送方法为最终实现。

若无可用公共桥接，应重新评估启动入口方案，例如外部启动器；不得用强制类型转换把事件上下文伪装成命令上下文。

非 TUI 模式收到 `--g` 时给出明确诊断，不尝试 custom UI。

### 2.3 会话内入口

`/go` 流程：

1. 拒绝重复进入同一个选择器。
2. `await ctx.waitForIdle()`。
3. 构建 catalog，保存当前 cwd/session 的纯数据标识。
4. 打开选择器。
5. 用户确认后关闭 UI，返回动作。
6. 对恢复/创建动作再次确认运行时可安全替换，并由 SessionGateway 执行。
7. 按 cancelled/success/error 分支处理。
8. 在 finally 中释放控制器占用标记。

### 2.4 创建跨目录 session：技术验证门槛

当前目录直接创建使用 `ctx.newSession()`。

目标目录不同于当前 cwd 时，不能假定 `newSession({ cwd })` 存在。

候选路径：通过公开 `SessionManager` 在目标 cwd 创建 session，使用其公开持久化能力生成一个合法、可打开的 session 文件，再通过 `ctx.switchSession(path)` 进入。

该路径必须先验证：

- 新 manager 的空 session 是否已经写盘；若采用延迟持久化，什么公开操作可可靠生成文件。
- 是否需要非模型上下文的初始化条目，以及该条目是否改变 transcript。
- 是否保留正确 cwd、存储目录、模型初始化和 session 名称。
- 切换是否触发目标项目信任流程和资源加载。
- 创建后取消切换时如何处理新生成的空文件。

未通过验证不得使用手写 JSONL header、调用私有方法、或临时 chdir 冒充正式切换。

如公共 API 无法可靠完成，应采用受支持的外部启动方式或调整依赖版本，再确定最终方案。

## 3. 数据模型

以下为 pi-go 自有模型，不声明它们是 Pi 已存在的类型。

```typescript
type ProjectId = string; // 规范化绝对 cwd
 type SessionKey = string; // 规范化绝对 session 文件路径

interface ProjectRecord {
  id: ProjectId;
  cwd: string;
  defaultName: string;
  displayName: string;
  pinned: boolean;
  lastUsedAt?: number;
  fallbackUpdatedAt?: number;
  sessionKeys: SessionKey[];
  availability: "available" | "missing" | "unknown";
}

interface SessionRecord {
  key: SessionKey;
  sessionId?: string;
  projectId: ProjectId;
  filePath: string;
  name?: string;
  displayTitle: string;
  pinned: boolean;
  lastUsedAt?: number;
  updatedAt?: number;
}

interface MetadataV1 {
  version: 1;
  projects: Record<ProjectId, {
    alias?: string;
    pinned?: boolean;
    lastUsedAt?: number;
    registered?: boolean;
  }>;
  sessions: Record<SessionKey, {
    pinned?: boolean;
    lastUsedAt?: number;
  }>;
  extraSessionDirs?: string[];
}
```

### 3.1 身份与路径

- 项目身份不能取目录 basename 或显示名称。
- 路径展开 `~`、转绝对路径、消除 `.`/`..` 和不必要的尾部分隔符。
- 不简单转小写，避免破坏区分大小写文件系统的语义。
- 第一版建议不强制 realpath 合并符号链接，保留 Pi session 中的逻辑 cwd；规范化策略必须对发现、登记和查询一致。
- 会话采用完整文件路径作 key，避免不同存储目录中的相同 ID 混淆。
- session 移动后的 pin 迁移不纳入第一版；旧 key 可保留，不能关联到无关文件。

### 3.2 虚拟项

“所有项目”和“新建会话”使用显式联合类型，不使用特殊路径字符串冒充普通数据：

```typescript
type ProjectRow = { kind: "all" } | { kind: "pinned-sessions" } | { kind: "project"; id: ProjectId };
type SessionRow = { kind: "new" } | { kind: "session"; key: SessionKey };
```

## 4. 元数据持久化

建议文件位置：`<Pi agentDir>/pi-go/state.json`。实现时通过公开配置/路径接口获得 agentDir，不硬编码用户主目录，以兼容自定义 Pi 配置目录。

- metadata 不进入模型上下文，不通过当前 session 的 appendEntry 保存全局状态。
- 别名、pin 和成功访问时间更新后立即持久化。
- 单进程写操作串行化；写临时文件后原子 rename。
- 保存前重新读取并应用字段级操作，避免无意覆盖其他字段。
- 多个 Pi 进程共用此文件时使用跨进程锁；锁范围覆盖读取、合并、写入。
- 锁等待有上限；锁失败显示反馈，不无限等待。
- 锁中保存进程及创建时间；失效清理不能只依赖时间而误删活跃锁。
- JSON 损坏时保留原文件并报告，必要时备份后重建，不静默覆盖。
- schema version 不支持时只读或提示升级，不破坏未知字段/版本。
- 元数据写失败不回滚已经成功的 session 切换；提示 pin/名称/访问时间可能未保存。

项目别名去掉首尾空白；空输入表示恢复默认名称。禁止换行及终端控制字符。session 标题和路径在 UI 中也必须转义/清理控制字符。

## 5. Catalog 构建

1. 从 Pi 公开 session 列表 API 获取默认存储中的会话摘要。
2. 读取明确配置的额外 session 存储目录。
3. 按 session 文件 key 去重。
4. 按规范化 cwd 分组。
5. 合并已登记项目和当前 cwd，使无 session 的目录也可见。
6. 应用 alias、pin、lastUsedAt。
7. 缓存名称和路径的搜索索引。

不为每次按键读取全部会话正文。优先使用 Pi 提供的摘要/列表能力；API 的导出名、跨目录列举范围和摘要字段需实施前核对。

Pi 列表 API 跳过部分损坏 session，不阻断全部列表。每次打开时 inspectCatalogAvailability() 对历史 cwd、元数据项目路径及当前 cwd 做目录 stat，并对发现的 session 路径做文件 stat，最多各 16 个并发任务；支持取消。

buildCatalog() 接收此次打开的可用路径快照，registered / pin / 别名 / 访问记录不能将不存在或不可访问的 cwd 重新加入列表。会话文件不存在或其 cwd 不可访问时，不进入 session 列表或【置顶会话】分组。

不因存在性检查修改或删除持久元数据及实际文件，以保留离线磁盘的别名、pin 和顺序；不默认启动 watcher，外部清理后需重新打开 /go。移除原先“当前 session 文件未发现则补一条记录”的逻辑，未写盘的空会话和外部已删除的当前 JSONL 不显示为可恢复的历史。实际恢复/创建前仍再次检查。

## 6. 搜索与排序

### 6.1 搜索归一化

搜索字段预先执行 Unicode 规范化与大小写折叠，保留原文本用于显示。优先复用 Pi 导出的模糊匹配函数；具体导出待确认。不可用时使用独立、可单测的匹配器。

匹配返回布尔值及可选高亮位置。模糊分数不改变用户指定的 pin/最近使用排序；相关度排序属于后续可选能力。

项目匹配条件为 OR：

```text
项目显示名称匹配
或目录完整路径匹配
```

会话只匹配名称/约定的显示标题，不搜索消息正文。

### 6.2 联动规则（采用建议默认值）

- 左侧 query 为空（含纯空白）时显示“所有项目”；非空时隐藏该入口，仅显示匹配项目。
- 右侧 scope 由当前选中的项目决定。
- 空项目搜索下选 all 时右侧范围为全局；输入项目搜索词后自动进入实际匹配项目范围。
- 选具体项目时右侧范围为该项目全部 sessions。
- 左侧不匹配 session 名；项目和会话搜索索引完全分离。
- 有有效项目范围时“新建会话”保留且不参与模糊匹配；无匹配项目时右侧列表为空，不允许恢复或创建。

### 6.3 稳定排序

过滤后对普通数据使用以下 tuple：

```text
(pinned 优先, pinned 条目的 pinOrder 升序, effectiveLastUsedAt 降序, displayName/title, 唯一 key)
```

- session effectiveLastUsedAt = 元数据 lastUsedAt，否则 updatedAt，否则 0。
- 项目 effectiveLastUsedAt = 项目 lastUsedAt 与其子 session lastUsedAt 的最大值；都没有时取子 session updatedAt 最大值。
- 虚拟入口符合显示条件时，排序后插入第一行。
- 浏览、搜索、pin、重命名不更新访问时间。
- 只有创建/恢复成功才更新 session 和所属项目的 lastUsedAt。

### 6.4 选择修正

列表变化优先保留当前选中 key，而不是数组下标。

- 当前 key 仍可见：保持选择并修正滚动范围。
- 当前项目不再可见：选中当前列表第一个匹配项目；没有结果时进入 none 空选择，清空右侧 query 并重置右侧选择。none 不属于 all，不展示全局 session。
- 项目 key 实际发生变化：清空右侧 query，右侧选择“新建会话”。
- 右侧过滤使当前 session 不可见：选择“新建会话”。
- pin 导致排序变化：保持当前条目选择，滚动使其可见。

## 7. UI 与状态机

### 7.1 状态

```typescript
interface SelectorState {
  activePane: "projects" | "sessions";
  projectQuery: string;
  sessionQuery: string;
  selectedProject: ProjectRow | { kind: "none" };
  selectedSession: SessionRow;
  projectScroll: number;
  sessionScroll: number;
  stage: "loading" | "ready" | "directory" | "rename" | "error";
}
```

恢复/创建阶段发生在 custom UI 完成之后，不属于列表组件内部。

### 7.2 快捷键草案

| 按键 | 行为 |
|---|---|
| Tab / Shift+Tab | 切换活动栏 |
| ↑ / ↓ | 移动活动栏选择 |
| Enter，左栏 | 将焦点移到右栏，不直接恢复 |
| Enter，右栏 session | 返回恢复动作 |
| Enter，右栏新建 | 返回当前项目新建动作；all 下先选目录 |
| Esc | 子步骤返回；主界面取消 |
| Ctrl+P | pin/取消 pin 当前实际项目或 session |
| Alt+↑ / Alt+↓ | 将当前 pinned 条目与相邻可见置顶条目交换位置并保存 |
| Ctrl+R | 左栏重命名项目；右栏第一版不绑定 |
| Ctrl+Y（Yank） | 复制项目 cwd 到剪贴板，不关闭界面 |
| PageUp / PageDown | 按活动列表可视页移动（可选） |

这些快捷键是建议，除 Tab 和上下键外待用户确认。自定义组件活动期间拦截自己拥有的按键，关闭后不影响 Pi 的全局快捷键。

### 7.3 布局

- 使用一个 `ctx.ui.custom()` 组件，不创建第二个终端 renderer。
- 使用 Pi TUI 的 Input、容器、文本等组件；可复用的列表组件是否满足双栏独立搜索需验证。
- 顶部输入区与列表共享左右宽度和竖向分隔线。
- 默认左右接近等宽，右侧可适度更宽；比例放入布局常量，不作为第一版用户配置。
- 快捷键行允许按宽度压缩或换行。
- 项目行：pin 标记、名称；选中行或辅助区域显示完整路径。
- 会话行：pin 标记、标题、简短时间；all 范围显示项目名。
- 名称过长按终端列宽截断，完整信息在选中详情中展示。
- 窄窗口不擅自变成单栏；低于最小宽度显示扩大窗口提示，同时保留取消操作。

### 7.4 输入与渲染

- 使用 `matchesKey()`、Pi keybinding 能力处理输入，不手写 ANSI key 判断。
- 两个 Input 只让活动栏输入框获得焦点。
- 实现 Focusable 并正确透传 focus/CURSOR_MARKER，以支持中文输入法候选窗。
- 使用 visibleWidth、truncateToWidth 等处理中文、emoji 和 ANSI。
- 使用注入的 theme，不缓存永久的带主题颜色字符串。
- 数据更新后 invalidate 并 requestRender，不在 render 中读文件。
- 重建可见行只对可视区域渲染；无匹配项目时左栏显示空结果、右栏提示调整项目搜索，Enter 不执行动作。

## 8. 操作流程

### 8.1 恢复 session

```text
选中 session → 返回 restore(key) → 重新校验文件/目录
→ 等待安全切换 → ctx.switchSession(path, { withSession })
→ cancelled：不更新访问时间
→ success：使用新的上下文核对目标标识，保存访问时间
→ error：显示错误，允许重新打开选择器
```

如果目标就是当前 session，可作为无替换的成功访问关闭选择器并更新访问时间；不得无谓重建运行时。该路径需准确比较规范化 session 文件 key。

切换前必须捕获纯数据，不能在 withSession 中引用旧 ctx。元数据存储服务可保留，但不可依赖旧 session 绑定状态。

### 8.2 新建 session

- 具体项目：目标 cwd 为项目 cwd。
- all 范围：展示目录选择/输入，默认当前 cwd，并要求确认。
- 校验目录存在且是目录，不默认创建不存在的文件夹。
- 当前 cwd 使用 `ctx.newSession()`。
- 跨 cwd 使用通过第 2.4 节验证后的 SessionGateway 实现。
- 成功后登记项目并记录访问时间；session key 必须来自实际新 session。
- 如果新 session 文件延迟写盘，访问元数据不得构造不存在的伪 key；应在能获得真实标识后保存。

### 8.3 复制项目目录

Ctrl+Y（Yank）复制项目目录；原 Ctrl+O 独立“打开目录”功能已移除：

1. 左栏选中具体项目时，使用该项目 cwd。
2. 右栏选中 session 时，通过 projectId 查找其所属项目 cwd；全局会话列表也遵循此规则。
3. 右栏选中“新建会话”时，若已选具体项目，使用该项目 cwd。
4. “所有项目”且没有选中实际 session 时，提示先选择具体项目或会话，不回退为启动目录。
5. 通过 Pi 公共 copyToClipboard() 复制原始目录字符串；成功/失败显示提示，界面、焦点、搜索和选择保持不变。

不得复制 session 文件路径，不改变 cwd、session、pin 或访问时间。底部详情也显示项目 cwd，避免与 session 存储路径混淆。

目录输入和浏览仅保留在“所有项目 → 新建会话”的目录确认步骤中，不再提供独立登记目录操作。

### 8.4 置顶手动排序

- ProjectMeta / SessionMeta 和 catalog 条目增加可选 `pinOrder`（非负安全整数），旧状态无需迁移。
- 未保存位置的置顶组使用最近使用排序；手动移动时为完整置顶组保存连续位置，之后不受访问时间影响。普通条目忽略 pinOrder。
- 活动栏按当前可见结果找出 pinned 邻居，排除“所有项目”“新建会话”及普通条目；Alt+↑ / Alt+↓ 仅交换这两个 key 的全局位置，保持隐藏条目的位置。
- MetadataStore.movePinned() 在跨进程锁内重读状态，以最新已保存顺序为准，校验双方仍 pinned，再分配顺序。仅修改 pinOrder，保留名称、pin 和访问时间。
- 排序成功后重新筛选并保留当前 key、焦点、两个搜索词；失败提示。边界不循环、不写入。
- 取消 pin 清除位置；新 pin 或重新 pin 排在已有手动排序条目之后。

### 8.5 【置顶会话】虚拟项目范围

- Catalog 按实际可发现的 pinned sessions 创建可选 pinnedSessionsGroup；无真实 pinned session 时为 undefined，不受损坏或已删除 session 的遗留 pin 标记影响。
- 固定显示名称为“【置顶会话】”，ProjectRow.kind 为 pinned-sessions。分组不是 Project，不具有 cwd，不创建虚假路径元数据。
- projectEntries() 将分组与普通项目合并用于筛选及排序。分组 pinned 始终为 true；未手动排序时以其会话最近使用时间作排序回退，手动位置存于 Metadata.pinnedSessionsGroup.pinOrder。
- Alt+↑↓ 通过保留标识 pi-go:pinned-sessions 参与项目置顶组交换；MetadataStore 在锁内临时投影该条目，保存位置到独立字段，绝不写入 projects 路径映射。消失后保留位置元数据，供再次出现时使用。
- Ctrl+P 在虚拟分组上只提示无法取消 pin；后端 patchProject() 也拒绝该保留标识。
- 右侧范围为全局 pinned sessions，显示其所属项目；标题搜索、会话排序、取消 pin、恢复和复制真实项目 cwd 保持原规则。
- 分组与原项目列表是同一 Catalog.sessions 的不同过滤视图；同一 file key / projectId 不复制、不迁移。两处均使用 session.pinOrder 排序并调用相同 movePinned("session") 路径，任一处调整后另一处同步显示。
- 最后一个会话取消 pin 后 refresh() 移除分组，若正在选中该分组则按现有可见列表回退选择，清空右侧搜索。左栏按分组名称过滤而非按子会话名称过滤。
- 分组内“新建会话”仍先确认 cwd；虚拟分组自身不可复制路径或重命名。

### 8.6 pin 与重命名

- 虚拟入口不可操作，显示轻量提示。
- pin 修改和重命名均先提交 MetadataStore，再更新视图；失败保持原状态并提示。
- 重命名只针对项目显示别名。
- 重命名后重建相关搜索索引，重新筛选；若当前项目被过滤掉，按选择修正规则回到 all。

## 9. 错误、取消与并发

- GoController 同一运行时只允许一个选择器；重复 `/go` 提示已有界面。
- 等待空闲时可取消；不得直接 abort 用户现有生成任务。
- 加载错误应显示重试/取消，不展示空列表假装没有历史。
- session 文件在加载后被删除：执行前检查并刷新条目。
- 目标目录不可用：提示路径，用户可取消或另选目录，不自动重绑定 cwd。
- 信任检查/切换被取消：保留现有环境，不记录成功访问。
- 替换过程中异常：不假定旧运行时仍有效，使用 Pi 对外错误路径处理；不得用旧 ctx 自动重试。
- 元数据并发修改：按字段操作合并，不使用整个内存快照盲写。
- 切换资源卸载时不清除未完成的元数据写入；持久化操作应有明确完成边界。

## 10. 性能

- 首次加载一次 catalog，不在每个输入事件扫描磁盘。
- 搜索索引预归一化；项目仅维护名称和路径索引，会话维护独立标题索引。
- 项目 query 更新只计算项目匹配；右侧 query 更新只计算当前 scope。
- 数据规模大时输入触发的异步计算使用递增 revision，忽略过期结果。
- 第一版可用同步内存过滤，实际性能测量后再引入 debounce，避免不必要的输入延迟。
- 列表只渲染视口；持久化与 session 扫描不得进入 render 热路径。

## 11. 建议文件结构

```text
index.ts                      扩展注册入口
src/controller.ts             流程控制
src/startup-adapter.ts         启动桥接
src/session-gateway.ts         Pi session API 适配
src/session-repository.ts      历史发现
src/catalog.ts                项目/session 归并
src/metadata-store.ts          schema、锁、原子写
src/path-utils.ts              路径规范化
src/search.ts                  模糊匹配
src/sort.ts                    稳定排序
src/ui/go-selector.ts          双栏组件
src/ui/view-model.ts           状态与选择修正
src/ui/directory-picker.ts     目录子步骤
src/types.ts                   自有类型
 tests/                        单测及集成验证
 docs/                         需求和设计
```

实际依赖、测试框架和分发 package.json 在技术验证后确定，不为文档阶段预设未经核对的版本。

## 12. 测试计划

### 12.1 单元测试

- 路径规范化、同 basename 不合并、符号链接策略。
- 按项目名/目录路径匹配项目；会话名称和正文不得命中项目。
- 全局与具体项目 session 搜索范围。
- pin 不绕过过滤；非空项目搜索隐藏 all，唯一匹配自动选中；无结果不回退全局，清空搜索恢复 all。
- pin/时间/稳定 key 排序和时间缺失回退。
- 项目实际改变才清空右侧 query。
- 过滤、pin、重命名后的 key 保留与选择修正。
- metadata schema、损坏文件、锁失败、并发字段更新、原子写失败。
- 控制字符清理和中文匹配。

### 12.2 TUI 测试

- Tab、Shift+Tab、↑↓、Enter、Esc 和建议快捷键。
- 两个输入框分别保留内容，输入法焦点正确。
- 中文/emoji/长路径、窗口缩放、窄窗口、主题变化。
- 无项目历史、无 session、搜索无结果。
- 上千条会话时滚动与输入响应。

### 12.3 Pi 集成测试

- --g 首次启动触发，session_start 再触发不重开。
- --g 不向模型发送 `/go` 文本。
- /go 等待 idle，取消不 abort 原任务。
- 跨项目恢复后 read/bash 的真实 cwd、项目上下文、扩展与资源正确。
- 当前目录和跨目录新建均可恢复且记录 cwd 正确。
- 项目信任机制不被绕过。
- cancelled 不更新访问时间。
- withSession 使用新上下文，旧上下文没有后续调用。
- 非 TUI 模式不打开 custom UI。
- 两个 Pi 进程修改元数据不会丢失不同条目的更新。

## 13. 实施顺序与阻塞项

1. 确认需求 Q1–Q9，尤其左侧/全局过滤语义与 all 下新建目录。
2. 技术验证：启动命令桥接、公开 session 列表 API、跨 cwd 创建与持久化、项目信任、agentDir 获取。
3. 完成类型、搜索排序和 ViewModel 单测。
4. 实现 MetadataStore 和 Catalog。
5. 实现双栏 UI，先使用静态数据验证输入与布局。
6. 接入 /go 恢复与当前目录新建。
7. 接入跨目录新建与 --g 一次性启动。
8. 集成测试、打包和安装说明。

启动桥接和跨目录新建是原设计的可行性阻塞项；现已通过下述方式实现并测试。

## 14. v0.1.0 实施记录

### 已完成

- `index.ts` 注册 `/go` 和 boolean 参数 `--g`，使用进程级共享 guard 避免 session 替换或 reload 再次触发启动界面。
- 启动桥接使用公共 `pi.sendUserMessage("/go", { expandPromptTemplates: true })`，通过 timer 在 session_start 返回后派发。真实扩展文件加载测试确认命令不进入模型 transcript。
- `src/ui/load-with-progress.ts` 使用 BorderedLoader，等待 idle 并加载历史，Esc 取消发现而不 abort 现有模型任务。
- 双栏选择器、独立输入焦点、中文列宽、pin、项目别名、目录输入及非递归候选浏览已实现。
- `SessionManager.listAll()` 发现默认历史，`listAll(customDir)` 发现显式平铺存储，catalog 对会话文件路径去重。Pi 列表 API 自行跳过部分损坏文件，目前不另行统计损坏数量。
- 状态保存使用 owner.json 跨进程锁、字段合并、临时文件 fsync 及原子 rename；损坏数据不覆盖，异常退出残留锁需人工确认后删除，不自动回收活跃或不明状态的锁。
- session 恢复使用 `switchSession()` 和新上下文 `withSession`，同一目录新建使用 `newSession()`。
- 跨目录新建使用 `SessionManager.create()` 和 `appendCustomEntry()`，序列化其公共 `getHeader()` / `getEntries()` 快照，以 wx 写入文件，再正式 switchSession。这是对原设计“只通过 manager 触发持久化”的调整：Pi 1.1.0 不提供空会话 flush，单纯追加 custom entry 仍不会写盘。实际方案没有手写 header 字段、调用私有方法或伪造用户消息。
- 跨目录创建的初始化 custom 条目不参与模型上下文；取消切换时仅清理内容仍等于原始 seed 的新文件。
- 初始目录为当前 cwd；右栏初始选中“新建会话”；all 下新建先确认目录。其他交互采用需求 Q1–Q9 建议默认值。

### 验证及边界

- TypeScript 严格检查通过。
- 自动测试覆盖搜索 / pin / 稳定排序 / 选择修正 / 跨进程元数据 / session 快照 / 启动桥接 / 双栏按键及宽字符。
- 真实 Pi SDK 测试验证 cwd-bound runtime 替换、read 工具相对路径、目标 AGENTS.md、历史恢复，以及真实扩展文件 --g 与 /go 打开相同界面而不请求模型。
- CLI help smoke test 能显示 --g 扩展参数。
- `--no-session` 下不支持跨目录新建，提示改用持久化会话。
- 不提供 session 删除、全文搜索、正则搜索或对系统 pi 命令的 -g 包装。
- 发现加载错误会返回 Pi 扩展错误提示，用户可以重新运行 /go；尚未提供加载界面内的独立重试按钮。
- 真实终端中文 IME、主题变化、窗口缩放和项目 trust 对话框需继续手动验收；自动测试不替代这些体验检查。

最新运行和安装方式见 [README](../README.md)。
