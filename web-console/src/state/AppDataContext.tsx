/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HttpConsoleClient, type ConsoleClient } from "../api/client";
import { useEventStream } from "../api/event-stream";
import type {
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  CreateTaskInput,
  CreateTaskResult,
  HealthDto,
  SessionDto,
  TaskCommandInput,
  TaskCommandResult,
} from "../types/domain";
import { MockConsoleClient } from "../mocks/mock-client";
import { queryCache } from "../queries/core";
import { invalidationPlan, queryKeys } from "../queries/keys";

export type DataSource = "api" | "mock";

interface AppDataContextValue {
  client: ConsoleClient;
  dataSource: DataSource;
  session: SessionDto | null;
  health: HealthDto | null;
  healthUnavailable: boolean;
  /** True while the live event stream is disconnected in api mode. */
  streamOffline: boolean;
  createTask: (input: CreateTaskInput) => Promise<CreateTaskResult>;
  taskCommand: (taskId: string, input: TaskCommandInput) => Promise<TaskCommandResult>;
  requestReminder: (taskId: string, subtaskId: string) => Promise<void>;
  decide: (approvalId: string, input: ApprovalDecisionInput) => Promise<ApprovalDecisionResult>;
  bulkMarkForEdit: (approvalIds: string[]) => Promise<string[]>;
  refreshAll: () => void;
}

const AppDataContext = createContext<AppDataContextValue | null>(null);

function createClient(dataSource: DataSource): ConsoleClient {
  return dataSource === "mock" ? new MockConsoleClient() : new HttpConsoleClient();
}

export function AppDataProvider({ children }: { children: ReactNode }) {
  const dataSource = (import.meta.env.VITE_DATA_SOURCE as DataSource | undefined) ?? "api";
  const clientRef = useRef<ConsoleClient>(null as unknown as ConsoleClient);
  if (clientRef.current === null) clientRef.current = createClient(dataSource);
  const client = clientRef.current;

  const [session, setSession] = useState<SessionDto | null>(null);
  const [health, setHealth] = useState<HealthDto | null>(null);
  const [healthUnavailable, setHealthUnavailable] = useState(false);
  const [streamOffline, setStreamOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    client.getSession().then((value) => {
      if (!cancelled) setSession(value);
    }).catch(() => {
      if (!cancelled) setSession(null);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const refreshHealth = useCallback(() => {
    client.getHealth().then((value) => {
      setHealth(value);
      setHealthUnavailable(false);
    }).catch(() => {
      setHealthUnavailable(true);
    });
  }, [client]);

  useEffect(() => {
    refreshHealth();
    const timer = window.setInterval(refreshHealth, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshHealth]);

  const invalidate = useCallback((prefixes: string[]) => {
    for (const prefix of prefixes) queryCache.invalidate(prefix);
  }, []);

  const handleStreamEvent = useCallback(
    (event: { type: string }) => {
      setStreamOffline(false);
      if (event.type === "snapshot.required") {
        queryCache.invalidate("*");
        return;
      }
      invalidate(invalidationPlan(event.type));
    },
    [invalidate],
  );

  useEventStream(handleStreamEvent, dataSource === "api");

  // Detect stream drop: EventSource retries silently; poll health meanwhile.
  useEffect(() => {
    if (dataSource !== "api") {
      setStreamOffline(false);
      return;
    }
    const timer = window.setInterval(() => {
      // If health says degraded because of the queue, keep the badge honest.
      void refreshHealth();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [dataSource, refreshHealth]);

  const createTask = useCallback(
    async (input: CreateTaskInput) => {
      const result = await client.createTask(input);
      invalidate(["overview", "tasks", "health"]);
      return result;
    },
    [client, invalidate],
  );

  const taskCommand = useCallback(
    async (taskId: string, input: TaskCommandInput) => {
      const result = await client.taskCommand(taskId, input);
      invalidate(["overview", "tasks", `task::${taskId}`, `taskEvents::${taskId}`, "health"]);
      return result;
    },
    [client, invalidate],
  );

  const requestReminder = useCallback(
    async (taskId: string, subtaskId: string) => {
      await client.requestReminder(taskId, subtaskId);
      invalidate([`task::${taskId}`, `taskEvents::${taskId}`, "health"]);
    },
    [client, invalidate],
  );

  const decide = useCallback(
    async (approvalId: string, input: ApprovalDecisionInput) => {
      const result = await client.decide(approvalId, input);
      invalidate(["approvals", "overview", "task", "health"]);
      return result;
    },
    [client, invalidate],
  );

  const bulkMarkForEdit = useCallback(
    async (approvalIds: string[]) => {
      const result = await client.bulkDecisions({ approvalIds, decision: "mark_for_edit" });
      invalidate(["approvals", "overview", "task", "health"]);
      return result.changed;
    },
    [client, invalidate],
  );

  const refreshAll = useCallback(() => queryCache.invalidate("*"), []);

  const value = useMemo<AppDataContextValue>(
    () => ({
      client,
      dataSource,
      session,
      health,
      healthUnavailable,
      streamOffline,
      createTask,
      taskCommand,
      requestReminder,
      decide,
      bulkMarkForEdit,
      refreshAll,
    }),
    [client, dataSource, session, health, healthUnavailable, streamOffline, createTask, taskCommand, requestReminder, decide, bulkMarkForEdit, refreshAll],
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData() {
  const value = useContext(AppDataContext);
  if (!value) throw new Error("useAppData must be used inside AppDataProvider");
  return value;
}

export { queryKeys };
