import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR } from "../config/index.js";

export type TaskStatus = "active" | "paused";
export type AgentTask = {
  id: string;
  title: string;
  status: TaskStatus;
  checkpoint?: string;
  pauseReason?: string;
  createdAt: number;
  updatedAt: number;
};

type Ledger = Record<string, AgentTask[]>;
type State = {
  ledger: Ledger;
  loaded: boolean;
  loading?: Promise<void>;
  saving: Promise<void>;
};
const states = new Map<string, State>();

function file(userId?: string) {
  return path.join(
    CONFIG_DIR,
    "tasks",
    "users",
    userId ?? "default",
    "ledger.json"
  );
}
function key(agentId: string, sessionId: string) {
  return JSON.stringify([agentId, sessionId]);
}
async function state(userId?: string) {
  const target = file(userId);
  let current = states.get(target);
  if (!current) {
    current = { ledger: {}, loaded: false, saving: Promise.resolve() };
    states.set(target, current);
  }
  if (!current.loaded) {
    current.loading ??= (async () => {
      try {
        const ledger = JSON.parse(await fs.readFile(target, "utf8")) as Record<
          string,
          AgentTask | AgentTask[]
        >;
        current!.ledger = Object.fromEntries(
          Object.entries(ledger).map(([entryKey, value]) => [
            entryKey,
            Array.isArray(value) ? value : [value],
          ])
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        current!.ledger = {};
      }
      current!.loaded = true;
    })();
    await current.loading;
  }
  return current;
}
async function persist(userId: string | undefined, ledger: Ledger) {
  const target = file(userId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(ledger, null, 2));
  await fs.rename(tmp, target);
}
async function commit<T>(
  userId: string | undefined,
  current: State,
  change: (ledger: Ledger) => { ledger: Ledger; result: T }
) {
  const write = current.saving.then(async () => {
    const { ledger, result } = change(current.ledger);
    await persist(userId, ledger);
    current.ledger = ledger;
    return result;
  });
  current.saving = write.then(
    () => undefined,
    () => undefined
  );
  return write;
}

export async function getTask(
  agentId: string,
  sessionId: string,
  userId?: string,
  taskId?: string
) {
  const tasks = (await state(userId)).ledger[key(agentId, sessionId)] ?? [];
  if (taskId) return tasks.find((task) => task.id === taskId);
  return tasks.find((task) => task.status === "active") ?? tasks.at(-1);
}
export async function getTasks(
  agentId: string,
  sessionId: string,
  userId?: string
) {
  return (await state(userId)).ledger[key(agentId, sessionId)] ?? [];
}
export async function adoptTask(
  agentId: string,
  sessionId: string,
  title: string,
  userId?: string
) {
  const current = await state(userId);
  return commit(userId, current, (ledger) => {
    const taskKey = key(agentId, sessionId);
    const tasks = ledger[taskKey] ?? [];
    if (tasks.some((task) => task.status === "active"))
      throw new Error("An unfinished task already exists for this session");
    const task: AgentTask = {
      id: crypto.randomUUID(),
      title,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return { ledger: { ...ledger, [taskKey]: [...tasks, task] }, result: task };
  });
}
export async function updateTask(
  agentId: string,
  sessionId: string,
  userId: string | undefined,
  update: Partial<Pick<AgentTask, "checkpoint" | "pauseReason" | "status">>,
  taskId?: string
) {
  const current = await state(userId);
  return commit(userId, current, (ledger) => {
    const taskKey = key(agentId, sessionId);
    const tasks = ledger[taskKey] ?? [];
    if (
      update.status === "active" &&
      tasks.some((task) => task.status === "active")
    )
      throw new Error("An active task already exists for this session");
    const task = taskId
      ? tasks.find((candidate) => candidate.id === taskId)
      : tasks.find((candidate) =>
          update.status === "active"
            ? candidate.status === "paused"
            : candidate.status === "active"
        );
    if (!task) throw new Error("No active task for this session");
    if (update.status === "active" && task.status !== "paused")
      throw new Error("Only a paused task can be resumed");
    const updated = { ...task, ...update, updatedAt: Date.now() };
    return {
      ledger: {
        ...ledger,
        [taskKey]: tasks.map((candidate) =>
          candidate.id === task.id ? updated : candidate
        ),
      },
      result: updated,
    };
  });
}
export async function completeTask(
  agentId: string,
  sessionId: string,
  userId?: string,
  taskId?: string
) {
  const current = await state(userId);
  return commit(userId, current, (ledger) => {
    const taskKey = key(agentId, sessionId);
    const tasks = ledger[taskKey] ?? [];
    const task = taskId
      ? tasks.find((candidate) => candidate.id === taskId)
      : tasks.find((candidate) => candidate.status === "active");
    if (!task) throw new Error("No active task for this session");
    const remaining = tasks.filter((candidate) => candidate.id !== task.id);
    const next = { ...ledger };
    if (remaining.length) next[taskKey] = remaining;
    else delete next[taskKey];
    return { ledger: next, result: task };
  });
}
export function resetTaskStoreForTests() {
  states.clear();
}
