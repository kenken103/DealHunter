export type RequestDraftSummary = {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
};

export type DraftAttachment = { name: string; contentBase64: string };

export const draftTextFields = [
  "project", "upperCompany", "primeCompany", "endCompany", "category", "remarks", "totalRounds",
  "summary", "participantName", "participantNameKana", "leaderId",
] as const;

export type RequestDraftContent = {
  version: 1;
  values: Record<string, string>;
  slots: string[];
  selectedStudents: string[];
  assignmentMode: "direct" | "leader";
  scheduleMode: "candidates" | "availability";
  requestedDates: string[];
  addingUpperCompany: boolean;
  addingEndCompany: boolean;
  attachment?: DraftAttachment | null;
};

export type RequestDraft = RequestDraftSummary & { content: RequestDraftContent };
