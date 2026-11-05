export interface TaskNotification {
  taskId: string;
  toolUseId: string;
  status: string;
  summary: string;
  durationMs: number | null;
}

const field = (part: string, tag: string): string => {
  // No closing tag required: long notices get trimmed, but id and status come first.
  const m = new RegExp(`<${tag}>([^<]*)`).exec(part);
  return m ? m[1].trim() : "";
};

/** Parses every <task-notification> in a text, field by field, tolerating a missing closing tag. */
export function parseNotifications(text: string): TaskNotification[] {
  const out: TaskNotification[] = [];
  for (const part of text.split("<task-notification>").slice(1)) {
    const taskId = field(part, "task-id");
    const toolUseId = field(part, "tool-use-id");
    if (!taskId && !toolUseId) continue;
    const d = Number(field(part, "duration_ms"));
    out.push({
      taskId,
      toolUseId,
      status: field(part, "status") || "completed",
      summary: field(part, "summary"),
      durationMs: Number.isFinite(d) && field(part, "duration_ms") !== "" ? d : null,
    });
  }
  return out;
}

export const isFailedStatus = (status: string): boolean => /fail|error|timeout/i.test(status);
