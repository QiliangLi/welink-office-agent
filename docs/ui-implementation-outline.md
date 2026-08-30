> **状态说明（2026-08-30）**：本文是最初的产品意图/路线笔记，描述到 mock 原型为止。UI 已按 `docs/frontend-backend-integration.md` 接入真实 Console API；当前实现约束以 `docs/agent-guides/web-console.md` 为准。

最合适的方式不是“把 PNG 一键转成 HTML”，而是把这些 UI 图当作**视觉规格图**，让 Codex 按页面逐步重建。这样代码结构、响应式、状态交互都会比截图转代码干净很多。

我建议你走下面这条路线。

### 1. 先定前端技术栈

这个任务面板不复杂，我建议：

```text
React + Vite
Tailwind CSS
Lucide Icons
React Router
```

第一版甚至不需要 Next.js。

目录可以直接这样：

```text
web-console/
├── src/
│   ├── components/
│   │   ├── Sidebar.tsx
│   │   ├── Topbar.tsx
│   │   ├── StatusBadge.tsx
│   │   ├── TaskCard.tsx
│   │   ├── AgentMascot.tsx
│   │   └── ...
│   │
│   ├── layouts/
│   │   └── AppLayout.tsx
│   │
│   ├── pages/
│   │   ├── Overview.tsx
│   │   ├── Tasks.tsx
│   │   ├── NewTask.tsx
│   │   ├── TaskDetail.tsx
│   │   └── Approvals.tsx
│   │
│   ├── mocks/
│   │   └── tasks.ts
│   │
│   ├── types/
│   │   └── task.ts
│   │
│   └── App.tsx
│
└── public/
    └── assets/
```

这正好对应我们刚才生成的 5 张核心页面。

---

## 2. 不要让 Codex 一次性实现五张图

这是最容易翻车的地方。

正确顺序应该是：

```text
第一步
搭 App Shell
    ↓
Sidebar
Topbar
页面主体区域

第二步
做 Overview

第三步
抽公共组件

第四步
做 Tasks

第五步
做 New Task

第六步
做 Task Detail

第七步
做 Approvals

第八步
接真实 task 数据
```

先把**静态 UI 复刻好**，再接 welink-office-agent。

不要一开始同时做：

```text
UI
+
后端
+
SSE
+
任务调度
+
Skill
```

这样很容易最后哪一层都不完整。

---

# 3. 图片怎么给 Codex

把刚刚生成的图片放到项目里，例如：

```text
docs/design-reference/
├── overview.png
├── tasks.png
├── new-task.png
├── task-detail.png
└── approvals.png
```

然后直接在 Codex 里给它图片和下面这种 Prompt。

比如做 Overview：

```text
请根据 docs/design-reference/overview.png 实现这个页面。

技术栈：
- React
- TypeScript
- Tailwind CSS
- lucide-react
- React Router

要求：

1. 图片只是视觉参考，不允许直接把图片作为网页背景。
2. 必须使用真实 HTML / React 组件重新实现。
3. 页面需要响应式，但主要目标分辨率是 1440px 宽桌面端。
4. 风格：
   - 白色/极浅蓝背景
   - 蓝紫色作为主色
   - 大圆角卡片
   - 很轻的边框和阴影
   - 可爱但保持 Office 产品感
5. 暂时全部使用 mock data。
6. 中文文字不要照抄截图中明显错误的 AI 生图文字，
   根据页面语义填写合理内容。
7. Sidebar 和 Topbar 必须拆成独立组件。
8. 状态 Badge 必须抽象为公共组件：
   running / waiting / approval / failed / completed。
9. 不要过度拆组件，只有真正复用的部分才拆。
10. 页面视觉布局尽量接近参考图，包括：
   - 卡片比例
   - 页面留白
   - 栏宽
   - 字体层次
   - 卡片圆角
   - 信息密度

先完成 Overview 页面，不要实现其他页面。
```

这个 Prompt 会比：

> “根据这张图片写网页”

靠谱很多。

---

# 4. 第一件事情其实应该做 Design Tokens

不要让 Codex 每一页自己猜颜色。

先让它建立：

```css
:root {
  --app-bg: #f7f8fc;

  --card-bg: #ffffff;
  --card-border: #e9ebf4;

  --primary: #625bf6;
  --primary-soft: #f0efff;

  --success: #2fc87c;
  --success-soft: #ebfaf2;

  --warning: #f5a524;
  --warning-soft: #fff7e8;

  --danger: #ef5b5b;
  --danger-soft: #fff0f0;

  --text-primary: #202235;
  --text-secondary: #73778c;
  --text-muted: #a2a6b6;

  --radius-sm: 10px;
  --radius-md: 14px;
  --radius-lg: 20px;
}
```

实际颜色可以让 Codex根据图片微调。

这样五个页面不会出现：

```text
Overview 是 #605cff

Tasks 是 #735df5

Approvals 又变成 #535bea
```

最后看起来像三个产品。

---

# 5. 最大的问题是那些“可爱机器人”

截图里的机器人**不要让前端代码重画**。

CSS / SVG 重画这些机器人没有必要。

最适合的方式是单独生成几张透明背景的 mascot asset。

比如：

```text
robot-working.png
robot-waiting.png
robot-approval.png
robot-success.png
robot-empty.png
```

要求：

```text
PNG
透明背景
1:1
1024×1024
统一角色
统一风格
```

前端直接：

```tsx
<img
  src="/assets/robot-working.png"
  className="w-40 object-contain"
/>
```

这样既保持可爱感，也不会让 UI 工程复杂化。

截图里面的小机器人其实属于：

> **Visual Asset**

而不是：

> UI component。

---

# 6. 图标不要从截图裁

像：

```text
任务
待我处理
Activity
Artifacts
Settings
Bell
Search
Calendar
Check
Clock
```

全部用：

```text
lucide-react
```

例如：

```tsx
import {
  LayoutDashboard,
  ListTodo,
  CircleUserRound,
  Activity,
  Package,
  Settings,
  Bell,
  Search,
  Clock,
  CheckCircle2
} from "lucide-react";
```

这样视觉会非常干净。

---

# 7. UI 图里有些内容不要照着实现

这一点很重要。

AI 生成的 UI 图是**设计概念图，不是规范稿**。

里面通常有：

* 错误文字
* 错误日期
* 奇怪的人名
* 不合理的统计数字
* 不一致的 task ID
* 某些按钮逻辑矛盾

比如图里的：

```text
2024-05-28
2025-05-20
task-20220520...
```

这些都不要复制。

你应该让 Codex：

```text
复刻视觉
≠
复制内容
```

内容应该按照我们之前定义好的任务模型重新填。

---

# 8. TaskDetail 是最值得单独迭代的一页

这个页面不要期待第一遍就完成。

建议：

```text
Round 1
整体布局

Round 2
执行计划

Round 3
当前状态

Round 4
Timeline

Round 5
交互细节
```

特别是左边这种：

```text
✓ Step 1
│
✓ Step 2
│
├── ✓ A
├── ✓ B
└── ● C
│
○ Step 3
```

最好做成真正的数据驱动组件：

```tsx
<TaskPlan
  steps={[
    {
      title: "获取三方意见",
      status: "running",
      children: [...]
    }
  ]}
/>
```

不要直接在 JSX 里硬编码整棵树。

以后 welink-office-agent 输出新的 subtask，这里才能动态显示。

---

# 9. 我建议第一版先统一一个 Task 类型

例如：

```ts
export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_external"
  | "waiting_approval"
  | "paused"
  | "failed"
  | "completed";

export interface Task {
  id: string;
  title: string;

  status: TaskStatus;

  description?: string;

  currentAction?: string;
  blockedBy?: string;

  createdAt: string;
  updatedAt: string;

  completedSubtasks: number;
  totalSubtasks: number;

  nextAction?: string;
  nextCheckAt?: string;
}
```

然后五张页面**全部围绕同一个数据类型写**。

这很重要，因为以后接 Skill 时不需要推翻 UI。

---

# 10. 第一版 UI 数据全部 Mock

比如：

```ts
export const mockTasks: Task[] = [
  {
    id: "task-023",
    title: "收集 XXX 技术方案意见",

    status: "waiting_external",

    currentAction: "等待王XX回复",
    blockedBy: "王XX",

    completedSubtasks: 4,
    totalSubtasks: 6,

    nextAction: "汇总三方意见",

    createdAt: "2026-08-30T09:30:00+08:00",
    updatedAt: "2026-08-30T11:12:00+08:00"
  }
];
```

把 UI 做稳定以后才改成：

```text
mockTasks
    ↓
GET /api/tasks
```

这样开发会顺很多。

---

# 11. 整体开发路线我建议这样

```text
PNG UI reference
       │
       ▼
┌──────────────────┐
│ Design Tokens    │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ App Layout       │
│ Sidebar + Topbar │
└────────┬─────────┘
         │
         ▼
Overview
         │
         ▼
Tasks
         │
         ▼
New Task
         │
         ▼
Task Detail
         │
         ▼
Approvals
         │
         ▼
Mock Data Model
         │
         ▼
UI 完整可运行
         │
         ▼
Task API
         │
         ▼
welink-office-agent
```

**最后两步才碰 Skill。**

---

## 12. 你甚至可以要求 Codex做“视觉 diff”

每完成一页：

```text
打开本地网页
↓
截图
↓
与参考 UI 对比
↓
调整
```

然后给它这种指令：

```text
现在对照 docs/design-reference/tasks.png 检查当前实现。

重点检查：
1. sidebar 宽度
2. 主体最大宽度
3. 卡片间距
4. 字体大小层次
5. border radius
6. 表格行高
7. 右侧 sidebar 比例
8. 主色和状态色
9. whitespace
10. 是否过度使用阴影

不要增加新功能，只做视觉一致性调整。
```

这种“实现 → 截图 → 对比 → 微调”，通常两三轮之后效果会很好。

---

## 我的建议

你现在**不要找所谓的 PNG-to-React 一键工具作为主方案**。

你已经有：

* 完整页面结构
* ASCII 设计
* 5 张视觉参考图
* 明确的 Task 数据语义

这种情况下，用 Codex **按视觉稿重建组件**反而最省事。

最终应该是：

```text
UI 图片
    ↓
只负责回答：
“长什么样”

我们之前的 Task 设计
    ↓
负责回答：
“数据是什么、交互是什么”

Codex
    ↓
负责把两者变成：
真实 React 页面
```

尤其不要让 AI 生图决定产品逻辑，它只负责视觉。产品逻辑还是以我们前面定的 **Overview / Tasks / New Task / Task Detail / Approvals** 和任务状态模型为准。
