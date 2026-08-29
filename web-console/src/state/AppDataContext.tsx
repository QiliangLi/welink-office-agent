/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { initialApprovals, initialTasks, people } from "../mocks/data";
import type { Approval, ApprovalStatus, NewTaskInput, Task, TaskStatus } from "../types/domain";

interface AppDataContextValue {
  tasks: Task[];
  approvals: Approval[];
  updateTaskStatus: (taskId: string, status: TaskStatus) => void;
  resolveApproval: (approvalId: string, status: ApprovalStatus) => void;
  resolveAllApprovals: () => void;
  createTask: (input: NewTaskInput) => Task;
}

const AppDataContext = createContext<AppDataContextValue | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState(initialTasks);
  const [approvals, setApprovals] = useState(initialApprovals);

  const value = useMemo<AppDataContextValue>(
    () => ({
      tasks,
      approvals,
      updateTaskStatus(taskId, status) {
        setTasks((current) =>
          current.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  status,
                  updatedAt: "2026-08-30T12:00:00+08:00",
                  currentAction:
                    status === "paused"
                      ? "等待你继续任务"
                      : status === "running"
                        ? "正在恢复执行计划"
                        : status === "stopped"
                          ? "任务已由你停止"
                          : task.currentAction,
                }
              : task,
          ),
        );
      },
      resolveApproval(approvalId, status) {
        setApprovals((current) => current.map((approval) => (approval.id === approvalId ? { ...approval, status } : approval)));
      },
      resolveAllApprovals() {
        setApprovals((current) => current.map((approval) => (approval.status === "pending" ? { ...approval, status: "edited" } : approval)));
      },
      createTask(input) {
        const nextNumber = tasks.length + 1;
        const task: Task = {
          id: `TASK-20260830-${String(nextNumber).padStart(3, "0")}`,
          title: input.description.split(/[。！？\n]/)[0].slice(0, 32) || "新任务",
          description: input.description,
          status: "queued",
          category: "follow_up",
          currentAction: "等待 Agent 拆解任务",
          progress: 0,
          completedSubtasks: 0,
          totalSubtasks: 0,
          createdBy: people.me,
          contacts: [],
          createdAt: "2026-08-30T12:00:00+08:00",
          updatedAt: "2026-08-30T12:00:00+08:00",
          estimatedCompletion: input.deadline,
          plan: [],
          activity: [],
        };
        setTasks((current) => [task, ...current]);
        return task;
      },
    }),
    [approvals, tasks],
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData() {
  const value = useContext(AppDataContext);
  if (!value) throw new Error("useAppData must be used inside AppDataProvider");
  return value;
}
