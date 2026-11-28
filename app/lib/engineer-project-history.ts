import type { DashboardData, ScheduleEvent } from "../types";

const outcomes = { passed:"合格", offered:"オファー", advanced:"次回面談へ", rejected:"見送り", declined:"辞退", pending:"面談・結果待ち" };
export function engineerCaseRows(data: DashboardData | null, studentId: string) {
  if (!data) return [];
  const rows = data.projects.flatMap(project => {
    const ownEvents = data.events.filter(e => e.studentId === studentId && e.projectId === project.id);
    const latest = (events: ScheduleEvent[]) => events.sort((a,b) => b.round-a.round || b.stamp-a.stamp || b.time.localeCompare(a.time))[0];
    const entry = latest(ownEvents.filter(e => e.entry));
    const meeting = latest(ownEvents.filter(e => !e.entry));
    const request = data.requests.find(r => r.projectId === project.id && r.studentId === studentId);
    const archive = data.importedCases.find(r => r.projectId === project.id && r.studentId === studentId);
    if (!request && !entry && !meeting && !archive) return [];
    const endedOn = entry?.endedOn || archive?.endedOn;
    const active = !endedOn && Boolean(entry ? entry.engineerConfirmedAt : archive?.status === "joined");
    const status = endedOn ? "参画終了" : active ? "入場中" : entry ? (entry.scheduleState === "cancelled" ? "初回入場中止" : entry.scheduleState === "postponed" ? "初回入場の再調整" : "初回入場予定")
      : meeting ? (meeting.scheduleState === "cancelled" ? "面談中止" : meeting.scheduleState === "postponed" ? "日程再調整中" : outcomes[meeting.result])
      : archive ? archive.outcome || "結果未登録" : request?.status === "requested" ? "日程回答待ち" : "日程調整中";
    const event = entry || meeting;
    const day = endedOn || (event && new Date(event.stamp).toISOString().slice(0,10)) || archive?.entryDate || archive?.interviewDate || request?.createdAt?.slice(0,10) || "";
    return [{ project, entry, meeting, archive, request, endedOn, active, status, day }];
  });
  return rows.sort((a,b) => b.day.localeCompare(a.day) || a.project.name.localeCompare(b.project.name,"ja"));
}
