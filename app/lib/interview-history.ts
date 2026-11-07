import type { ScheduleEvent } from "../types";

const sameAssignment = (left: ScheduleEvent, right: ScheduleEvent) =>
  left.projectId === right.projectId && left.studentId === right.studentId;

export function sourceInterview(event: ScheduleEvent, events: ScheduleEvent[]): ScheduleEvent | undefined {
  if (!event.entry) return event;
  if (event.parentEventId) {
    return events.find(item => !item.entry && item.key === event.parentEventId && sameAssignment(item, event));
  }
  if (!event.requestId) return undefined;
  const matches = events.filter(item => !item.entry && item.requestId === event.requestId && sameAssignment(item, event));
  return matches.length === 1 ? matches[0] : undefined;
}

export function entryForInterview(event: ScheduleEvent, events: ScheduleEvent[]): ScheduleEvent | undefined {
  const exact = events.find(item => item.entry && item.parentEventId === event.key && sameAssignment(item, event));
  if (exact || !event.requestId) return exact;
  const matches = events.filter(item => item.entry && !item.parentEventId && item.requestId === event.requestId && sameAssignment(item, event));
  return matches.length === 1 ? matches[0] : undefined;
}
