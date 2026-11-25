"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { DashboardData, MutationResult, NotificationPreview } from "../types";
import { MeetingRecord } from "./MeetingRecord";
import { ConfirmForm, NoticeForm, salesRequestState, slotLabel } from "./SalesSchedule";
import CompanyInterviewHistory from "./CompanyInterviewHistory";
import { checkInterviewerCompanies, CompanyWarningList, InterviewerCompanyWarning, type CompanyWarning } from "./InterviewerCompanyWarnings";
import MultiDatePicker from "./MultiDatePicker";
import { SharedInterviewSlots } from "./SharedInterviewSlots";
import { AvailableInterviewerSearch } from "./AvailableInterviewerSearch";
import { SalesCompanyFields } from "./CompanyField";
import { checkSimilarProjects, SimilarProjectReview, type ProjectComparison, type SimilarProjectNotice } from "./SimilarProjectReview";
import { EntryDayWarning, readEntryWarning, type EntryReview } from "./EntryDayWarning";
import { companyNameForDisplay, trimEndCompany as trimCompanyName } from "../lib/company-name";
import { dateTimeInput, japanDayStamp } from "../lib/business-date";
import { draftTextFields, type DraftAttachment, type RequestDraft, type RequestDraftContent, type RequestDraftSummary } from "../lib/request-draft";
import "./sales-workflow.css";

export type PreviewDialogKey = { kind: "new" | "confirm" | "notice" | "entry" | "feedback" | "request" | "recruitment" | "notification" | "next-round"; requestId?: string; recruitmentId?: string; eventId?: string; notificationId?: string };
type Props = { active: PreviewDialogKey | null; data: DashboardData; onClose: () => void; onSaved: () => Promise<void> };
type DraftProps = { initialDraft?: RequestDraft; onDraftSaved?: (summary: RequestDraftSummary) => void };
type Values = Record<string, string>;
type DraftSlot = { key: number; start: string };
type ScheduleMode = "candidates" | "availability";
type AssignmentMode = "direct" | "leader";
const assignmentOptions = {
  direct: { title: "担当を決めて面談作成", description: "営業が面談者を選び、本人に直接依頼します。" },
  leader: { title: "担当者を後からアサイン", description: "担当リーダーに依頼し、後から面談者を選んでもらいます。" },
} satisfies Record<AssignmentMode, { title: string; description: string }>;
type Pending = { path: string; payload: unknown; preview: NotificationPreview; entry?: EntryReview; companyWarnings?: CompanyWarning[] };
type CompanyInfo = { upperCompany?: string; primeCompany?: string; endCompany?: string; category?: string };
const trimCompany = (value: string) => value.replace(/^[\p{White_Space}\uFEFF]+|[\p{White_Space}\uFEFF]+$/gu, "");
const companyLines = (company: CompanyInfo) => [{ label: "上位会社", value: companyNameForDisplay(company.upperCompany) ?? "未登録" }, { label: "元請け", value: company.primeCompany || "未登録" }, { label: "エンド企業", value: companyNameForDisplay(company.endCompany) ?? "未入力" }, { label: "種類", value: company.category || "未登録" }];
const companyPairs = (company: CompanyInfo): [string, ReactNode][] => companyLines(company).map(line => [line.label, line.value]);
const readable = (value: string) => value.replace("T", " ").replace(/([+-]\d\d:\d\d|Z)$/, "");
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validStart = (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(`${value}:00+09:00`));
const MAX_ATTACHMENT = 5 * 1024 * 1024;
const attachmentAccept = ".pdf,.xls,.xlsx,.doc,.docx";
function attachmentError(file: File) {
  if (!/\.(pdf|xls|xlsx|doc|docx)$/i.test(file.name)) return "PDF、Excel、Wordのファイルを選択してください。";
  if (!file.size || file.size > MAX_ATTACHMENT) return "ファイルは1バイト以上、5MB以下にしてください。";
  return "";
}
function encodeAttachment(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("ファイルを読み込めませんでした。もう一度選択してください。"));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result.slice(reader.result.indexOf(",") + 1)) : reject(new Error("ファイルを読み込めませんでした。"));
    reader.readAsDataURL(file);
  });
}
async function serializeAttachment(file: File | DraftAttachment | null): Promise<DraftAttachment | null> {
  return file instanceof File ? { name: file.name, contentBase64: await encodeAttachment(file) } : file;
}
function Info({ pairs }: { pairs: [string, ReactNode][] }) { return <dl className="d-list">{pairs.map(([label, value], index) => <div className="d-row" key={`${label}-${index}`}><dt className="d-label">{label}</dt><dd className="d-info">{value}</dd></div>)}</dl>; }
function Field({ title, children }: { title: string; children: ReactNode }) { return <label className="d-label"><span>{title}</span>{children}</label>; }
function Preview({ preview }: { preview: NotificationPreview }) {
  return <><h3 className="sales-preview-title">{preview.title}</h3><Info pairs={preview.lines.map(line => [line.label, /^(http:\/\/127\.0\.0\.1:3100\/|\/(sales|engineer|leader)(\?|$))/.test(line.value) ? <a className="sales-url" href={line.value}>{line.value}</a> : line.value])} />{preview.body && <p className="d-question sales-preserve-lines">{preview.body}</p>}</>;
}

const newRequest: PreviewDialogKey = { kind: "new" };

export function NewInterviewRequestForm(props: Omit<Props, "active"> & DraftProps) {
  return <SalesWorkflow {...props} active={newRequest} standalone />;
}

export default function PreviewDialog(props: Props) {
  return <SalesWorkflow {...props} />;
}

function SalesWorkflow({ active, data, onClose, onSaved, standalone = false, initialDraft, onDraftSaved }: Props & DraftProps & { standalone?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), opener = useRef<HTMLElement | null>(null), sequence = useRef(2), savingRef = useRef(false);
  const [values, setValues] = useState<Values>({}), [slots, setSlots] = useState<DraftSlot[]>([]), [pending, setPending] = useState<Pending | null>(null), [saved, setSaved] = useState<MutationResult | null>(null), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const [selectedStudents, setSelectedStudents] = useState<string[]>([]);
  const [addingUpperCompany, setAddingUpperCompany] = useState(false);
  const [addingEndCompany, setAddingEndCompany] = useState(false);
  const [acknowledgedToken, setAcknowledgedToken] = useState("");
  const [assignmentMode, setAssignmentMode] = useState<AssignmentMode>(initialDraft?.content.assignmentMode ?? "direct");
  const [choosingAssignment, setChoosingAssignment] = useState(standalone && !initialDraft);
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("candidates");
  const [requestedDates, setRequestedDates] = useState<string[]>([]);
  const [commonFile, setCommonFile] = useState<File | DraftAttachment | null>(null);
  const [draft, setDraft] = useState<RequestDraftSummary | undefined>(initialDraft);
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftConflict, setDraftConflict] = useState(false);
  const creationKey = useRef<string | null>(null);
  const [requestFile, setRequestFile] = useState<File | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [similarNotice, setSimilarNotice] = useState<SimilarProjectNotice | null>(null);
  const checkedComparison = useRef("");
  const [dirty, setDirty] = useState(false), [discardConfirm, setDiscardConfirm] = useState(false);
  const preparingRef = useRef(false);
  const explicitClose = useRef(false);
  const attachmentInput = useRef<HTMLInputElement | null>(null);
  const request = data.requests.find(item => item.id === active?.requestId), event = data.events.find(item => item.key === active?.eventId), feedback = data.feedbacks.find(item => item.eventId === active?.eventId), notification = data.notifications.find(item => item.id === active?.notificationId);
  const recruitment = data.recruitments?.find(item => item.id === active?.recruitmentId);
  const recruitmentProject = data.projects.find(item => item.id === recruitment?.projectId);
  const project = data.projects.find(item => item.id === (request?.projectId ?? event?.projectId ?? recruitment?.projectId));
  const canEdit = active?.kind === "new" || (!!project && project.salesId === data.currentUser.id);
  const leaders = data.leaders ?? [];
  const interviewerOptions = data.students.map(student => {
    const sameName = data.students.some(other => other.id !== student.id && other.name === student.name);
    return { id: student.id, sameName, name: sameName ? `${student.name}（${student.id}）` : student.name };
  });

  useEffect(() => {
    const element = dialog.current;
    if (!active) { if (element?.open) element.close(); return; }
    const targetRequest = data.requests.find(item => item.id === active.requestId), targetEvent = data.events.find(item => item.key === active.eventId);
    const today = japanDayStamp();
    const entryDay = Math.max(today, targetEvent?.stamp ?? today) + 86400000;
    setValues({ project: "", upperCompany: "", primeCompany: "", endCompany: "", category: "", remarks: "", totalRounds: String(active.kind === "next-round" ? Math.max((targetEvent?.round || 1) + 1, targetEvent?.totalRounds || 1) : 1), summary: "", participantName: "", participantNameKana: "", leaderId: "", slotId: targetRequest?.availableSlotIds[0] ?? "", url: targetEvent?.url ?? "", result: targetEvent?.result === "offered" ? "passed" : "offered", when: dateTimeInput(entryDay), where: "", memo: "" });
    setSelectedStudents([]); setAddingUpperCompany(false); setAddingEndCompany(false); setCommonFile(null); setRequestFile(null); setPreparing(false); preparingRef.current = false;
    setSlots(active.kind === "next-round" ? [{ key: 0, start: "" }] : [{ key: 0, start: dateTimeInput(today + 86400000, "13:00") }, { key: 1, start: dateTimeInput(today + 2 * 86400000, "15:00") }]); sequence.current = 2;
    setAssignmentMode("direct"); setScheduleMode("candidates"); setRequestedDates([]);
    setSimilarNotice(null); checkedComparison.current = "";
    if (standalone && initialDraft) {
      const content = initialDraft.content;
      setValues(content.values); setSelectedStudents(content.selectedStudents);
      setAddingUpperCompany(content.addingUpperCompany); setAddingEndCompany(content.addingEndCompany);
      setSlots(content.slots.map((start, key) => ({ key, start }))); sequence.current = content.slots.length;
      setRequestedDates(content.requestedDates);
      setScheduleMode(content.scheduleMode); setAssignmentMode(content.assignmentMode);
      setCommonFile(content.attachment ?? null);
    }
    setPending(null); setSaved(null); setError(""); setSaving(false); setDirty(false); setDiscardConfirm(false); savingRef.current = false; explicitClose.current = false;
    if (element) {
      if (!element.open) { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; element.showModal(); }
      element.scrollTop = 0; heading.current?.focus({ preventScroll: true });
    }
    // A data refresh must preserve the current form and saved confirmation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  useEffect(() => {
    if (standalone) window.scrollTo(0, 0);
    else if (dialog.current?.open) dialog.current.scrollTop = 0;
    else return;
    heading.current?.focus({ preventScroll: true });
  }, [pending, saved, discardConfirm, similarNotice, standalone, choosingAssignment]);

  useEffect(() => {
    if (!standalone || !dirty || saved) return;
    function guardDraft(e: BeforeUnloadEvent) {
      if (explicitClose.current) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", guardDraft);
    return () => window.removeEventListener("beforeunload", guardDraft);
  }, [standalone, dirty, saved]);

  function closeWorkflow() {
    explicitClose.current = true;
    if (standalone) onClose();
    else dialog.current?.close();
  }

  function requestClose() {
    if (savingRef.current || preparingRef.current) return;
    if (discardConfirm) setDiscardConfirm(false);
    else if (!saved && dirty) setDiscardConfirm(true);
    else closeWorkflow();
  }

  function input(name: string) {
    const update = (value: string) => setValues(current => ({ ...current, [name]: value }));
    return { name, value: values[name] ?? "", onChange: (e: { currentTarget: { value: string } }) => update(e.currentTarget.value), onInput: (e: { currentTarget: { value: string } }) => update(e.currentTarget.value) };
  }
  function selectStudent(id: string, checked: boolean) {
    setDirty(true);
    setSelectedStudents(current => {
      if (current.includes(id) === checked) return current;
      return checked ? [...current, id] : current.filter(studentId => studentId !== id);
    });
  }
  function chooseAssignment(mode: AssignmentMode) {
    if (draft && mode !== assignmentMode) setDirty(true);
    setAssignmentMode(mode);
    setChoosingAssignment(false);
    setError("");
  }
  function candidateInput(index: number) {
    const update = (start: string) => setSlots(current => current.map((slot, i) => i === index ? { ...slot, start } : slot));
    return { name: `candidate-${index}-start`, value: slots[index]?.start ?? "", onChange: (e: { currentTarget: { value: string } }) => update(e.currentTarget.value), onInput: (e: { currentTarget: { value: string } }) => update(e.currentTarget.value) };
  }
  function showSimilarResult(input: ProjectComparison, notice: SimilarProjectNotice | null) {
    checkedComparison.current = notice?.kind === "unavailable" ? "" : JSON.stringify(input);
    setSimilarNotice(notice);
  }
  async function retrySimilar() {
    if (similarNotice?.kind !== "unavailable" || preparingRef.current) return;
    preparingRef.current = true; setPreparing(true);
    try { showSimilarResult(similarNotice.input, await checkSimilarProjects(similarNotice.input)); }
    finally { preparingRef.current = false; setPreparing(false); }
  }
  async function review(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (savingRef.current) return;
    setError("");
    const form = new FormData(e.currentTarget), read = (name: string) => String(form.get(name) ?? "").trim(), fields: Values = {};
    form.forEach((value, key) => { if (typeof value === "string") fields[key] = value; }); setValues(current => ({ ...current, ...fields }));
    if (active?.kind === "new") {
      const assignment = assignmentMode;
      const mode = read("scheduleMode");
      if (mode !== "candidates" && mode !== "availability") { setError("日程の調整方法を選択してください。"); return; }
      const candidates = mode === "candidates" ? slots.map((_, i) => ({ start: read(`candidate-${i}-start`) })) : [];
      const dates = mode === "availability" ? form.getAll("requestedDates").map(String).sort() : [];
      if (mode === "candidates" && !candidates.length) { setError("候補日時を1件以上入力してください。"); return; }
      if (!read("project") || !read("summary")) { setError("案件名と面談概要を入力してください。"); return; }
      const upperCompany = trimCompanyName(String(form.get("upperCompany") ?? "")), primeCompany = trimCompany(String(form.get("primeCompany") ?? "")), endCompany = trimCompanyName(String(form.get("endCompany") ?? "")), category = read("category"), remarks = read("remarks"), totalRounds = Number(read("totalRounds"));
      if (primeCompany.length > 200 || category.length > 100 || remarks.length > 2000) { setError("元請けは200文字、種類は100文字、備考は2000文字以内で入力してください。"); return; }
      if (!Number.isInteger(totalRounds) || totalRounds < 1 || totalRounds > 5) { setError("面談回数は1〜5回で入力してください。"); return; }
      if (!upperCompany) { setError("上位会社を選択するか、新しい会社名を入力してください。"); return; }
      if (upperCompany.length > 200 || endCompany.length > 200) { setError("上位会社・エンド企業はそれぞれ200文字以内で入力してください。"); return; }
      if (candidates.some(slot => !validStart(slot.start))) { setError("各候補の開始日時を入力してください。"); return; }
      if (new Set(candidates.map(slot => slot.start)).size !== candidates.length) { setError("同じ開始日時の候補が重複しています。"); return; }
      if (dates.some(date => !validDate(date))) { setError("指定する日付を確認してください。"); return; }
      if (new Set(dates).size !== dates.length) { setError("同じ指定日が重複しています。"); return; }
      const studentIds = assignment === "direct" ? form.getAll("studentIds").map(String) : [];
      const students = data.students.filter(item => studentIds.includes(item.id));
      const leader = leaders.find(item => item.id === read("leaderId"));
      if (!leader) { setError("担当リーダーを選択してください。"); return; }
      if (assignment === "direct" && (!studentIds.length || students.length !== studentIds.length)) { setError("面談者を1名以上選択してください。"); return; }
      const participantName = read("participantName"), participantNameKana = read("participantNameKana").normalize("NFC");
      if (participantName.length > 200 || participantNameKana.length > 200) { setError("参画者はそれぞれ200文字以内で入力してください。"); return; }
      if (participantNameKana && !/^[\u3041-\u3096\u309d\u309eー・　 ]+$/.test(participantNameKana)) { setError("参画者(ひらがな)はひらがなで入力してください。"); return; }
      const invalid = commonFile instanceof File ? attachmentError(commonFile) : "";
      if (invalid) { setError(invalid); return; }
      if (preparingRef.current) return;
      preparingRef.current = true; setPreparing(true);
      let attachment: DraftAttachment | undefined;
      let companyWarnings: CompanyWarning[] = [];
      const comparison = { project: read("project"), summary: read("summary"), upperCompany, endCompany };
      try {
        const [encodedFile, warnings, notice] = await Promise.all([
          serializeAttachment(commonFile),
          assignment === "direct" ? checkInterviewerCompanies(interviewerOptions.filter(student => studentIds.includes(student.id)), { upper: upperCompany, prime: primeCompany, end: endCompany }) : [],
          checkedComparison.current === JSON.stringify(comparison) ? null : checkSimilarProjects(comparison),
        ]);
        attachment = encodedFile ?? undefined;
        companyWarnings = warnings;
        showSimilarResult(comparison, notice);
      }
      catch (reason) { setError(reason instanceof Error ? reason.message : "ファイルを読み込めませんでした。"); return; }
      finally { preparingRef.current = false; setPreparing(false); }
      if (assignment === "direct") setSelectedStudents(studentIds);
      if (mode === "candidates") setSlots(current => current.map((slot, i) => ({ ...slot, ...candidates[i] })));
      if (mode === "availability") setRequestedDates(dates);
      setPending({ path: "requests", companyWarnings, payload: { project: read("project"), upperCompany, primeCompany, endCompany, category, remarks, totalRounds, summary: read("summary"), leaderId: leader.id, assignmentMode: assignment, studentIds, participantName, participantNameKana, scheduleMode: mode, requestedDates: dates, candidates, attachment }, preview: { title: assignment === "leader" ? "面談者の選定依頼・通知内容" : "面談依頼の登録・通知内容", lines: [{ label: "案件", value: read("project") }, ...companyLines({ upperCompany, primeCompany, endCompany, category }), { label: "予定面談回数", value: `${totalRounds}回` }, { label: "概要", value: read("summary") }, { label: "リーダー", value: leader.name }, { label: "面談者の選定方法", value: assignment === "leader" ? "リーダーに選定を依頼" : "営業が面談者を指定" }, { label: assignment === "leader" ? "面談者" : `面談者 ${students.length}名`, value: assignment === "leader" ? "面談者はリーダーが選定" : students.map(student => student.name).join("\n") }, { label: "参画者", value: participantName || "未登録" }, { label: "参画者(ひらがな)", value: participantNameKana || "未登録" }, { label: "スキルシート", value: commonFile?.name ?? "添付なし" }, { label: assignment === "leader" ? "選定依頼先" : "直接の通知先", value: assignment === "leader" ? `@${leader.name}` : students.map(student => `@${student.name}`).join("\n") }, { label: "日程の調整方法", value: mode === "candidates" ? "候補日時を提示" : "面談者に空き日時を確認" }, { label: mode === "candidates" ? "候補の開始日時" : "指定日", value: mode === "candidates" ? candidates.map(slot => readable(slot.start)).join("\n") : dates.length ? dates.join("\n") : "指定なし（面談者が日付から提案）" }], body: `${assignment === "leader" ? "担当リーダーへ面談者の選定を依頼し、選定後に面談者へ日程回答を依頼します。" : "選択した面談者へ直接依頼します。"}${mode === "candidates" ? "各面談者が参加可能な候補日時を回答します。" : "各面談者が参加可能な開始日時を提案し、営業が各人の回答から日時を確定します。"}共通のスキルシート1件を面談者に共有します。` } });
    } else if (active?.kind === "next-round" && event) {
      const candidates = scheduleMode === "candidates" ? slots.map((_, i) => ({ start: read(`candidate-${i}-start`) })) : [];
      const dates = scheduleMode === "availability" ? form.getAll("requestedDates").map(String).sort() : [];
      const totalRounds = Number(read("totalRounds"));
      if (!Number.isInteger(totalRounds) || totalRounds <= (event.round || 1) || totalRounds > 5) { setError("面談回数は次回の回数以上、5回以下で入力してください。"); return; }
      if (scheduleMode === "candidates" && (!candidates.length || candidates.some(slot => !validStart(slot.start)))) { setError("次回面談の候補日時を入力してください。"); return; }
      if (new Set(candidates.map(slot => slot.start)).size !== candidates.length || dates.some(date => !validDate(date))) { setError("候補日時の重複や指定日を確認してください。"); return; }
      setPending({ path: `events/${encodeURIComponent(event.key)}/next-round`, payload: { scheduleMode, candidates, requestedDates: dates, totalRounds }, preview: { title: "面談通過・次回面談依頼", lines: [{ label: "案件", value: event.project }, { label: "面談者", value: event.person }, { label: "今回の結果", value: "通過" }, { label: "次回面談", value: `${(event.round || 1) + 1}/${totalRounds}` }, { label: "日程", value: scheduleMode === "candidates" ? candidates.map(slot => readable(slot.start)).join("\n") : dates.length ? dates.join("、") : "面談者に空き日時を確認" }], body: "同じ案件・同じ面談者の履歴を残し、次回面談の日程回答を依頼します。" } });
    } else if (active?.kind === "entry" && event) {
      const result = read("result"), passed = result === "passed";
      const labels: Record<string, string> = { passed: "合格・初回入場予定を登録", offered: "オファー（入場日未定）", rejected: "見送り（先方不合格）", declined: "辞退（本人側）" };
      if (!labels[result]) { setError("面談結果を選択してください。"); return; }
      const eventPath = `events/${encodeURIComponent(event.key)}`;
      const when = read("when");
      let entry: EntryReview | undefined;
      if (passed) {
        if (preparingRef.current) return;
        preparingRef.current = true; setPreparing(true); setAcknowledgedToken("");
        try {
          const response = await fetch(`/api/workflow/${eventPath}/entry-check`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ when }),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "初回入場日の重複を確認できませんでした。");
          entry = { person: event.person, when, warning: readEntryWarning(data.entryWarning) };
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "初回入場日の重複を確認できませんでした。"); return;
        } finally { preparingRef.current = false; setPreparing(false); }
      }
      setPending({ path: `${eventPath}/${passed ? "entry" : "result"}`, payload: passed ? { result, when, where: read("where"), memo: read("memo") } : { result }, entry, preview: { title: passed ? "初回入場予定の登録内容" : "面談結果の登録内容", lines: [{ label: "案件", value: event.project }, ...companyLines(event), { label: "面談者", value: event.person }, { label: "参画者", value: event.participantName || "未登録" }, { label: "リーダー", value: event.leaderName || "未設定" }, { label: "面談結果", value: labels[result] }, ...(passed ? [{ label: "初回入場日時", value: readable(when) }, { label: "集合場所", value: read("where") }, { label: "当日の案内", value: read("memo") || "記載なし" }] : [])] } });
    }
  }
  async function saveDraft(closeAfterSave = false) {
    if (!standalone || saved || savingRef.current || preparingRef.current) return;
    savingRef.current = true; setDraftSaving(true); setError("");
    const update = draft && !draftConflict;
    try {
      const content: RequestDraftContent = {
        version: 1, values: Object.fromEntries(draftTextFields.map(key => [key, values[key] ?? ""])),
        selectedStudents, slots: slots.map(slot => slot.start), requestedDates,
        assignmentMode, scheduleMode, addingUpperCompany, addingEndCompany, attachment: await serializeAttachment(commonFile),
      };
      if (!update) creationKey.current ??= crypto.randomUUID();
      const response = await fetch(update ? `/api/request-drafts/${encodeURIComponent(draft.id)}` : "/api/request-drafts", {
        method: update ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update ? { content, revision: draft.revision } : { content, creationKey: creationKey.current }),
      });
      const result = await response.json() as RequestDraftSummary & { error?: string };
      if (!response.ok) {
        if (response.status === 409 || (update && response.status === 404)) {
          creationKey.current = null;
          setDraftConflict(true);
          throw new Error("保存先の下書きが更新または削除されました。最新の下書きを開くか、このタブの入力を別の下書きとして保存できます。");
        }
        throw new Error(result.error || "一時保存できませんでした。もう一度お試しください。");
      }
      creationKey.current = null;
      setDraft(result); setDraftConflict(false); setDirty(false);
      onDraftSaved?.(result);
      if (closeAfterSave) closeWorkflow();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "一時保存できませんでした。");
    } finally { savingRef.current = false; setDraftSaving(false); }
  }

  async function save() {
    if (!canEdit) return;
    if (!pending || savingRef.current || draftConflict) return;
    const warning = pending.entry?.warning;
    if (warning && acknowledgedToken !== warning.token) return;
    savingRef.current = true; setSaving(true); setError("");
    try {
      const payload = {
        ...pending.payload as object,
        ...(warning && { entryWarningToken: warning.token }),
        ...(standalone && draft && { draftId: draft.id, draftRevision: draft.revision }),
      };
      const response = await fetch(`/api/workflow/${pending.path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as MutationResult & { error?: string; code?: string; entryWarning?: unknown };
      if (!response.ok) {
        if (standalone && draft && response.status === 409 && result.code === "DRAFT_CONFLICT") {
          setDraftConflict(true);
          throw new Error("保存先の下書きが更新または削除されました。最新の下書きを開くか、このタブの入力を別の下書きとして保存できます。");
        }
        if (response.status === 409 && pending.entry && result.code === "ENTRY_DAY_CONFLICT") {
          setAcknowledgedToken("");
          const updated = readEntryWarning(result.entryWarning);
          if (!updated) throw new Error("最新の重複内容を取得できませんでした。戻って日程を確認してください。");
          setPending({ ...pending, entry: { ...pending.entry, warning: updated } });
          setError("確認後に同日の入場予定が変わりました。最新の重複内容を確認してください。");
          return;
        }
        if (response.status === 409 && (active?.kind === "notice" || active?.kind === "confirm")) {
          await onSaved(); setPending(null);
        }
        throw new Error(result.error || result.message || "保存できませんでした。入力を確認して再度お試しください。");
      }
      setSaved(result);
      await onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存できませんでした。"); }
    finally { savingRef.current = false; setSaving(false); }
  }

  async function saveRequestAttachment() {
    if (!canEdit) return;
    if (!request || !requestFile || savingRef.current) return;
    const invalid = attachmentError(requestFile);
    if (invalid) { setError(invalid); return; }
    savingRef.current = true; setSaving(true); setError("");
    try {
      const contentBase64 = await encodeAttachment(requestFile);
      const response = await fetch(`/api/workflow/requests/${encodeURIComponent(request.id)}/attachment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: requestFile.name, contentBase64 }) });
      const result = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error || "スキルシートを保存できませんでした。");
      await onSaved(); setRequestFile(null); setSaved({ message: result.message || "スキルシートを保存しました。" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "スキルシートを保存できませんでした。"); }
    finally { savingRef.current = false; setSaving(false); }
  }

  function selectAttachment(file: File | null) {
    setDirty(true);
    const invalid = file ? attachmentError(file) : "";
    if (!file && attachmentInput.current) attachmentInput.current.value = "";
    setCommonFile(file && !invalid ? file : null);
    setError(invalid);
  }

  let kicker = "営業の対応", title = "", body: ReactNode = null;
  if (!canEdit && event && ["notice", "entry", "next-round"].includes(active?.kind ?? "")) {
    kicker = "面談記録"; title = event.project;
    body = <><Info pairs={[["面談者", event.person], ["担当営業", project?.salesName]]} /><MeetingRecord event={event} /></>;
  } else if (discardConfirm) {
    kicker = "閉じる前の確認"; title = "入力中の内容があります";
    body = <><p className="d-note">{draft ? "最後に一時保存した後の変更があります。変更を破棄しても一時保存した内容は残ります。" : "保存していない入力内容があります。閉じると入力内容は破棄されます。"}</p>
      <div className="sales-dialog-actions">
        <button className="d-button" type="button" onClick={() => setDiscardConfirm(false)}>編集を続ける</button>
        {standalone && !draftConflict && <button className="sales-secondary" type="button" onClick={() => void saveDraft(true)}>一時保存して閉じる</button>}
        <button className="sales-secondary" type="button" onClick={closeWorkflow}>入力を破棄して閉じる</button>
      </div></>;
  } else if (saved) {
    kicker = "保存完了"; title = saved.message;
    body = <><p className="sales-success" role="status">担当案件に反映しました。</p>{(active?.kind === "new" || active?.kind === "confirm" || active?.kind === "notice") && pending ? <><Preview preview={pending.preview} />{saved.previews?.length ? <details className="sales-recipient-previews"><summary>保存した通知内容（{saved.previews.length}件）</summary>{saved.previews.map((preview, index) => <div key={index}><Preview preview={preview} /></div>)}</details> : saved.preview && <details className="sales-recipient-previews"><summary>保存した通知内容</summary><Preview preview={saved.preview} /></details>}</> : saved.preview && <Preview preview={saved.preview} />}{active?.kind !== "request" && <p className="d-note">通知・カレンダーの内容はローカルで確認できます。Larkへの送信・予定登録は行っていません。</p>}<button className="d-button" type="button" onClick={requestClose}>閉じる</button></>;
  } else if (pending && similarNotice) {
    kicker = "類似案件の確認";
    title = similarNotice.kind === "matches" ? "同じ案件の可能性があります" : "類似案件を確認できませんでした";
    body = <SimilarProjectReview notice={similarNotice} checking={preparing} onRetry={retrySimilar}
      onEdit={() => { setSimilarNotice(null); setPending(null); }}
      onContinue={() => {
        if (similarNotice.kind === "unavailable") checkedComparison.current = JSON.stringify(similarNotice.input);
        setSimilarNotice(null);
      }} />;
  } else if (pending) {
    kicker = "保存前の確認"; title = "入力内容を確認";
    const warning = pending.entry?.warning;
    const acknowledged = warning?.token === acknowledgedToken;
    const sameNameInterviewers = pending.path === "requests" && assignmentMode === "direct"
      ? interviewerOptions.filter(option => option.sameName && selectedStudents.includes(option.id))
      : [];
    body = <>
      {sameNameInterviewers.length > 0 && <Info pairs={[["同姓同名の面談者（選択した本人のID）", sameNameInterviewers.map(student => student.name).join("、")]]} />}
      {pending.entry && warning && <EntryDayWarning review={pending.entry} checked={acknowledged} disabled={saving} onCheck={checked => setAcknowledgedToken(checked ? warning.token : "")} />}
      {pending.companyWarnings && <CompanyWarningList warnings={pending.companyWarnings} />}
      <Preview preview={pending.preview} />
      <p className="d-note">保存すると担当案件へ反映されます。Larkへの送信・予定登録は行いません。日時は日本時間です。</p>
      <div className="sales-dialog-actions">
        <button className="sales-secondary" type="button" onClick={() => { setPending(null); setError(""); }} disabled={saving}>戻って編集</button>
        <button className="d-button" type="button" onClick={save} disabled={saving || draftConflict || (!!warning && !acknowledged)}>{saving ? "保存しています…" : "この内容で保存"}</button>
      </div>
    </>;
  } else if (active?.kind === "new" && choosingAssignment) {
    kicker = "面談依頼"; title = "新しい面談依頼を作成";
    body = <>
      <p className="request-assignment-intro">面談者の決め方を選んでください。</p>
      <div className="request-assignment-options" role="group" aria-label="面談者の決め方">
        {(["direct", "leader"] as const).map(mode => (
          <button key={mode} type="button" aria-labelledby={`assignment-${mode}-title`}
            aria-describedby={`assignment-${mode}-description`} onClick={() => chooseAssignment(mode)}>
            <strong id={`assignment-${mode}-title`}>{assignmentOptions[mode].title}</strong>
            <span id={`assignment-${mode}-description`}>{assignmentOptions[mode].description}</span>
            <svg className="icon" aria-hidden="true"><use href="/icons.svg#i-chevright" /></svg>
          </button>
        ))}
      </div>
    </>;
  } else if (active?.kind === "new") {
    kicker = "面談依頼"; title = "新しい面談依頼を作成";
    body = <>
      <div className="request-assignment-current">
        <strong>{assignmentOptions[assignmentMode].title}</strong>
        <button className="text-link" type="button" disabled={preparing || draftSaving} onClick={() => {
          setError("");
          setChoosingAssignment(true);
        }}>面談者の決め方を変更</button>
      </div>
      {assignmentMode === "direct" && <AvailableInterviewerSearch people={interviewerOptions} selected={selectedStudents} disabled={preparing} onSelect={selectStudent} />}
      <form className="d-fields" inert={preparing} onSubmit={review}>
      <Field title="案件名"><input {...input("project")} placeholder="例：販売管理システムの機能追加" required maxLength={200} /></Field>
      <SalesCompanyFields upper={{
        value: values.upperCompany ?? "", onChange: value => setValues(current => ({ ...current, upperCompany: value })),
        addingNew: addingUpperCompany, onAddingNewChange: setAddingUpperCompany, knownCompanies: data.projects.map(project => project.upperCompany),
      }} end={{
        value: values.endCompany ?? "", onChange: value => setValues(current => ({ ...current, endCompany: value })),
        addingNew: addingEndCompany, onAddingNewChange: setAddingEndCompany, knownCompanies: data.projects.map(project => project.endCompany),
      }} />
      <div className="sales-company-fields"><Field title="元請け（任意）"><input {...input("primeCompany")} maxLength={200} placeholder="元請け企業名" /></Field><Field title="種類（任意）"><input {...input("category")} maxLength={100} list="case-categories" placeholder="例：Java、AWS" /><datalist id="case-categories">{["Java", "AWS", "Python", "PHP", "iOS", ".NET"].map(value => <option key={value} value={value} />)}</datalist></Field></div><Field title="面談概要"><textarea {...input("summary")} rows={3} placeholder="案件内容や面談で確認したいこと" required /></Field><Field title="備考（営業・管理者のみ）"><textarea {...input("remarks")} rows={2} maxLength={2000} placeholder="営業内部の補足事項" /></Field><Field title="予定面談回数"><select {...input("totalRounds")} aria-label="予定面談回数">{[1,2,3,4,5].map(count => <option key={count} value={count}>{count}回</option>)}</select></Field>
      <Field title="担当リーダー"><select {...input("leaderId")} aria-label="担当リーダー" required><option value="" disabled>担当リーダーを選択</option>{leaders.map(leader => <option value={leader.id} key={leader.id}>{leader.name}</option>)}</select></Field>
      {assignmentMode === "direct" ? <fieldset className="sales-members" aria-describedby="sales-members-note"><legend>面談者 <span>複数選択可</span></legend><p id="sales-members-note" className="sales-field-note">1名以上選択してください。依頼・回答・面談結果は一人ずつ管理します。</p><div className="sales-member-options">{interviewerOptions.map(student => <label className="sales-member-option" key={student.id}><input type="checkbox" name="studentIds" value={student.id} disabled={preparing} checked={selectedStudents.includes(student.id)} onChange={e => selectStudent(student.id, e.currentTarget.checked)} /><span>{student.name}</span></label>)}</div><p className="sales-member-count" aria-live="polite">選択 {selectedStudents.length}名</p></fieldset> : <p className="sales-assignment-note">面談者はリーダーが選定します。選定が完了すると、面談者ごとの日程回答へ進みます。</p>}
      {assignmentMode === "direct" && interviewerOptions.filter(student => selectedStudents.includes(student.id)).map(student =>
        <SharedInterviewSlots key={student.id} studentId={student.id} name={student.name} />)}
      {assignmentMode === "direct" && <CompanyInterviewHistory data={data} companies={[values.upperCompany, values.primeCompany, values.endCompany].filter(Boolean)} studentIds={selectedStudents} />}
      {assignmentMode === "direct" && interviewerOptions.filter(student => selectedStudents.includes(student.id)).map(student =>
        <InterviewerCompanyWarning key={student.id} student={student} companies={{ upper: values.upperCompany ?? "", prime: values.primeCompany ?? "", end: values.endCompany ?? "" }} />)}
      <Field title="参画者"><input {...input("participantName")} maxLength={200} placeholder="例：山田 太郎" /></Field>
      <Field title="参画者(ひらがな)"><input {...input("participantNameKana")} maxLength={200} placeholder="例：やまだ たろう" /></Field>
      <p className="sales-field-note">参画者を入力してください。面談者と異なる方も登録できます。実際の案件遂行者・フォロー者は管理画面で後から設定します。</p>
      <fieldset className="sales-attachments"><legend>スキルシート（任意・1ファイル）</legend><p className="sales-field-note">{assignmentMode === "leader" ? "共通の1ファイルを保存し、リーダーの選定後にすべての面談者へ共有します。" : "この依頼で共通の1ファイルを、選択したすべての面談者に共有します。"}PDF・Excel・Word、5MB以下。</p><div className="sales-attachment-item"><label htmlFor="skill-common">共通のスキルシート</label><input id="skill-common" ref={attachmentInput} disabled={preparing} type="file" accept={attachmentAccept} onChange={e => { const file = e.currentTarget.files?.[0] ?? null; selectAttachment(file); if (file && attachmentError(file)) e.currentTarget.value = ""; }} /><span>{commonFile ? `選択中：${commonFile.name}` : "添付なし"}</span>{commonFile && <button type="button" className="text-link" onClick={() => selectAttachment(null)}>添付を解除</button>}</div></fieldset>
      <fieldset className="sales-scheduling"><legend>日程の調整方法</legend><div className="sales-scheduling-options"><label><input type="radio" name="scheduleMode" value="candidates" checked={scheduleMode === "candidates"} disabled={preparing} onChange={() => { setScheduleMode("candidates"); setError(""); }} /><span><strong>候補日時を提示する</strong><small>営業が開始日時を指定し、面談者が選びます。</small></span></label><label><input type="radio" name="scheduleMode" value="availability" checked={scheduleMode === "availability"} disabled={preparing} onChange={() => { setScheduleMode("availability"); setError(""); }} /><span><strong>面談者に空き日時を確認する</strong><small>面談者から参加可能な開始日時を提案してもらいます。</small></span></label></div></fieldset>
      {scheduleMode === "candidates" ? <><p className="sales-field-note">面談の開始日時を入力してください。</p>{slots.map((slot, i) => <fieldset className="sales-slot" key={slot.key}><legend>候補日時 {i + 1}</legend><Field title={`候補 ${i + 1} の開始日時`}><input {...candidateInput(i)} type="datetime-local" required disabled={preparing} /></Field><button type="button" className="text-link" disabled={slots.length <= 1 || preparing} onClick={() => { setDirty(true); setSlots(current => current.filter(item => item.key !== slot.key)); }}>この候補を削除</button></fieldset>)}<button type="button" className="sales-secondary" disabled={preparing} onClick={() => { setDirty(true); setSlots(current => [...current, { key: sequence.current++, start: "" }]); }}>＋ 候補日時を追加</button></> : <fieldset className="sales-requested-dates"><legend>日付の指定（任意）</legend><p className="sales-field-note">カレンダーから複数の日付を選択できます。同じ日付をもう一度押すと解除できます。日付を指定しない場合は、面談者が日付から提案します。</p><MultiDatePicker value={requestedDates} onChange={dates => { setRequestedDates(dates); setDirty(true); }} disabled={preparing} /></fieldset>}
      <button className="d-button" type="submit" disabled={(assignmentMode === "direct" && !data.students.length) || !leaders.length || preparing}>{preparing ? "依頼内容を確認中…" : "依頼内容・Lark通知を確認"}</button></form><p className="d-note">{assignmentMode === "leader" ? "リーダーが面談者を選定した後、各面談者が自分のホームから日程を回答します。" : "各面談者が自分のホームから回答します。"}営業が日時を確定します。URLは後から共有できます。日時は日本時間です。</p>{!leaders.length && <p className="sales-error" role="alert">担当リーダーを取得できません。最新の一覧を読み込んでください。</p>}</>;
  } else if (active?.kind === "confirm" && request && canEdit) {
    title = request.responseKind === "unavailable" ? "候補日時を再調整" : "面談日時を確定";
  } else if (active?.kind === "notice" && event) {
    title = event.scheduleState === "cancelled" ? "中止した面談の記録" : event.result !== "pending" || event.status !== "scheduled" ? "先方評価・次回の準備事項" : "面談日時・案内の管理";
  } else if (active?.kind === "next-round" && event) {
    title = "通過・次回面談を依頼";
    body = <><Info pairs={[["案件", event.project], ["面談者", event.person], ["今回の面談", `${event.round || 1}/${event.totalRounds || 1}`]]} /><form className="d-fields" onSubmit={review}><Field title="全体の予定面談回数"><select {...input("totalRounds")} aria-label="全体の予定面談回数">{[1,2,3,4,5].filter(count => count > (event.round || 1)).map(count => <option key={count} value={count}>{count}回</option>)}</select></Field><Field title="日程の調整方法"><select aria-label="次回面談の日程調整方法" value={scheduleMode} onChange={e => setScheduleMode(e.currentTarget.value as ScheduleMode)}><option value="candidates">候補日時を提示する</option><option value="availability">面談者に空き日時を確認する</option></select></Field>{scheduleMode === "candidates" ? <>{slots.map((slot, i) => <fieldset className="sales-slot" key={slot.key}><legend>次回面談の候補 {i + 1}</legend><Field title={`候補 ${i + 1} の開始日時`}><input {...candidateInput(i)} type="datetime-local" required /></Field><button type="button" className="text-link" disabled={slots.length <= 1} onClick={() => { setDirty(true); setSlots(current => current.filter(item => item.key !== slot.key)); }}>この候補を削除</button></fieldset>)}<button type="button" className="sales-secondary" onClick={() => { setDirty(true); setSlots(current => [...current, { key: sequence.current++, start: "" }]); }}>＋ 候補日時を追加</button></> : <fieldset className="sales-requested-dates"><legend>日付の指定（任意）</legend><MultiDatePicker value={requestedDates} onChange={dates => { setRequestedDates(dates); setDirty(true); }} /></fieldset>}<button className="d-button" type="submit">通過・次回依頼の内容を確認</button></form><p className="d-note">今回の面談を通過として保存し、同じ面談者へ次回面談の日程回答を依頼します。</p></>;
  } else if (active?.kind === "entry" && event) {
    title = "面談結果・初回入場を登録";
    body = <><Info pairs={[["案件", event.project], ...companyPairs(event), ["面談者", event.person], ["参画者", event.participantName || "未登録"], ["参画者(ひらがな)", event.participantNameKana || "未登録"], ["リーダー", event.leaderName || "未設定"]]} /><form className="d-fields" onSubmit={review}><Field title="面談結果"><select {...input("result")} aria-label="面談結果" disabled={preparing}><option value="offered">オファー（入場日未定）</option><option value="passed">合格・初回入場予定を登録</option><option value="rejected">見送り（先方不合格）</option><option value="declined">辞退（本人側）</option></select></Field>{values.result === "passed" && <><Field title="初回入場日時"><input {...input("when")} type="datetime-local" required disabled={preparing} /></Field><Field title="集合場所"><input {...input("where")} placeholder="例：本社ビル 1階受付" required disabled={preparing} /></Field><Field title="当日の案内"><textarea {...input("memo")} rows={3} placeholder="持ち物・受付方法など" disabled={preparing} /></Field></>}<button className="d-button" type="submit" disabled={preparing}>{preparing ? "入場予定を確認中…" : "登録内容を確認"}</button></form><p className="d-note">オファーは入場日が未定でも登録できます。面談者が初回入場の完了を確認すると、参画（入場済み）として表示します。</p></>;
  } else if (active?.kind === "feedback" && event) {
    title = "面談所感・提出状況";
    body = <><Info pairs={[["案件", event.project], ...companyPairs(event), ["面談者", event.person], ["参画者", event.participantName || "未登録"], ["参画者(ひらがな)", event.participantNameKana || "未登録"], ["リーダー", event.leaderName || "未設定"], ["提出状況", feedback ? "提出済み" : "受講者の入力待ち"]]} />{feedback ? <><Info pairs={[["業務内容", feedback.duties], ["作業工程", feedback.process], ["リモート頻度", feedback.remote], ["感想", feedback.impression]]} /><h3 className="d-label">聞かれた質問</h3>{feedback.questions.map((question, i) => <p className="d-question" key={i}>Q{i + 1}　{question}</p>)}</> : <><p className="d-info">受講者が業務内容・作業工程・リモート頻度・感想・聞かれた質問を記入する段階です。</p><p className="d-note">受講者ホームで所感を提出すると、この画面へ反映されます。</p></>}</>;
  } else if ((active?.kind === "request" || active?.kind === "confirm") && request) {
    title = "面談依頼の状況";
    body = <>
      <Info pairs={[["案件", request.project], ["担当営業", project?.salesName], ...companyPairs(request), ["面談者", request.person], ["参画者", request.participantName || "未登録"], ["参画者(ひらがな)", request.participantNameKana || "未登録"], ["リーダー", request.leaderName || "未設定"], ["概要", request.summary], ["状況", salesRequestState(request)], ["日程の調整方法", request.scheduleMode === "availability" ? "面談者に空き日時を確認" : "候補日時を提示"]]} />
      {request.responseNote && <Info pairs={[["面談者からの回答メモ", request.responseNote]]} />}
      {request.scheduleMode === "availability" && <Info pairs={[["指定日", request.requestedDates.length ? request.requestedDates.join("\n") : "指定なし"]]} />}
      <section className="sales-attachments"><h3>スキルシート{request.attachment?.scope === "request" ? "（以前の個別添付）" : "（共通・1ファイル）"}</h3>{request.attachment ? <p><a className="sales-url" href={`/api/requests/${encodeURIComponent(request.id)}/attachment`} download>{request.attachment.name} をダウンロード</a></p> : <p className="sales-field-note">添付はありません。</p>}{canEdit && <><label htmlFor="request-skill">{request.attachment ? "差し替えるファイル" : "添付するファイル"}</label><input id="request-skill" type="file" disabled={saving} accept={attachmentAccept} onChange={e => { const file = e.currentTarget.files?.[0] ?? null; const invalid = file ? attachmentError(file) : ""; setRequestFile(invalid ? null : file); setError(invalid); if (invalid) e.currentTarget.value = ""; }} />{requestFile && <p className="sales-field-note">選択中：{requestFile.name}</p>}<p className="sales-field-note">PDF・Excel・Word、5MB以下。この案件のすべての面談者に共有されます。</p>{request.attachment?.scope === "request" && <p className="sales-field-note">以前の個別添付は自動共有していません。ここで保存すると、案件共通の1ファイルとしてすべての面談者に共有されます。</p>}<button className="sales-secondary" type="button" disabled={!requestFile || saving} onClick={saveRequestAttachment}>{saving ? "保存しています…" : request.attachment ? "差し替えを保存" : "添付を保存"}</button></>}</section>
      <h3 className="d-label">{request.scheduleMode === "availability" ? "提案された開始日時" : "候補の開始日時と回答"}</h3>
      {request.candidates.length ? request.candidates.map(slot => <p className="d-question" key={slot.id}>{slotLabel(slot)}{slot.proposed ? "（本人提案）" : ""}<br /><strong>{request.confirmedSlotId === slot.id ? "確定" : request.availableSlotIds.includes(slot.id) ? "参加可能" : request.status === "requested" ? "回答待ち" : "選択なし"}</strong></p>) : <p className="d-note">面談者から参加可能な開始日時の提案を待っています。</p>}
    </>;
  } else if (active?.kind === "recruitment" && recruitment) {
    kicker = "面談者の選定"; title = "面談者の選定状況";
    const names = recruitment.studentIds.map(id => data.students.find(student => student.id === id)?.name ?? data.requests.find(item => item.projectId === recruitment.projectId && item.studentId === id)?.person ?? id);
    body = <>
      <Info pairs={[["案件", recruitment.project], ["担当営業", project?.salesName], ...companyPairs(recruitment), ["概要", recruitment.summary], ["リーダー", recruitment.leaderName], ["状況", recruitment.status === "pending" ? "リーダーの選定待ち" : "面談者の選定済み"], ["面談者", recruitment.status === "pending" ? "面談者はリーダーが選定" : names.join("\n") || "未選定"], ["参画者", recruitmentProject?.participantName || "未登録"], ["参画者(ひらがな)", recruitmentProject?.participantNameKana || "未登録"], ["日程の調整方法", recruitment.scheduleMode === "availability" ? "面談者に空き日時を確認" : "候補日時を提示"], [recruitment.scheduleMode === "availability" ? "指定日" : "候補の開始日時", recruitment.scheduleMode === "availability" ? recruitment.requestedDates.join("\n") || "指定なし" : recruitment.candidates.map(slot => readable(slot.start)).join("\n")], ["スキルシート", recruitment.attachment?.name || "添付なし"]]} />
      <p className="sales-assignment-note">{recruitment.status === "pending" ? "担当リーダーに面談者の選定を依頼しています。選定が完了すると、面談者ごとの依頼が作成され、日程回答へ進みます。" : "選定された各面談者の依頼から、日程の回答・確定状況を確認できます。"}</p>
      {recruitment.attachment && <p className="d-note">共通のスキルシートは、選定後に各面談者の依頼から確認できます。</p>}
    </>;
  } else if (active?.kind === "notification" && notification) {
    kicker = notification.kind === "calendar" ? "カレンダー登録内容" : "Lark通知内容"; title = "保存済みの通知プレビュー";
    body = <><Preview preview={notification} /><p className="d-note">ローカルで保存した送信内容です。外部サービスには送信していません。</p></>;
  } else if (active) { title = "対象を確認できません"; body = <p className="d-note">最新の一覧へ戻り、もう一度選択してください。</p>; }

  const Heading = standalone ? "h1" : "h2";
  const content = <div id="detail-body" onChangeCapture={() => { if (!saved) setDirty(true); }}>
    {standalone ? <div className="sales-request-page-toolbar">
      <div className="d-kicker">{kicker}</div>
      {!saved && !discardConfirm && <div className="request-draft-actions">
        {!choosingAssignment && <button className="sales-secondary" type="button" disabled={saving || preparing || draftSaving} onClick={() => void saveDraft()}>
          {draftSaving ? "一時保存中…" : draftConflict ? "別の下書きとして保存" : "一時保存"}
        </button>}
        <button className="sales-secondary" type="button" disabled={saving || preparing || draftSaving} onClick={requestClose}>閉じる</button>
      </div>}
    </div> : <div className="d-kicker">{kicker}</div>}
    <Heading className="d-title" id="modal-title" ref={heading} tabIndex={-1}>{title}</Heading>
    {standalone && draft && !saved && <p className="sales-field-note" role="status">
      {dirty ? "一時保存後に変更があります。" : "一時保存済み。"} 保存日時：{new Date(draft.updatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
    </p>}
    {error && <p className="sales-error" role="alert">{error}</p>}
    {standalone ? <div inert={draftSaving}>{body}</div> : body}
    {canEdit && active?.kind === "confirm" && request && !saved && <div hidden={Boolean(pending || discardConfirm)}><ConfirmForm key={request.id} request={request} requests={data.requests} onReview={setPending} onError={setError} /></div>}
    {canEdit && active?.kind === "notice" && event && !saved && <div hidden={Boolean(pending || discardConfirm)}><NoticeForm key={event.key} event={event} onReview={setPending} onError={setError} /></div>}
  </div>;
  if (standalone) return <section className="sales-request-page-form">{content}</section>;

  return <dialog ref={dialog} aria-labelledby="modal-title" onKeyDown={e => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); requestClose(); } }} onCancel={e => { e.preventDefault(); requestClose(); }} onClose={() => {
    if (active && dirty && !saved && !explicitClose.current) {
      setDiscardConfirm(true);
      requestAnimationFrame(() => { const element = dialog.current; if (element?.isConnected && !element.open) { element.showModal(); element.scrollTop = 0; heading.current?.focus({ preventScroll: true }); } });
      return;
    }
    setDirty(false); setDiscardConfirm(false); setCommonFile(null); setRequestFile(null); setPending(null); setSaved(null); onClose();
    const target = opener.current?.isConnected ? opener.current : document.getElementById("tab-title");
    target?.focus({ preventScroll: true });
  }} onClick={e => {
    if (saving || preparing || e.target !== e.currentTarget) return;
    const bounds = e.currentTarget.getBoundingClientRect();
    if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) requestClose();
  }}>
    <div className="dialog-chrome"><strong>DealHunter</strong><button type="button" aria-label="閉じる" disabled={saving || preparing} onClick={requestClose}><svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>
    {content}
  </dialog>;
}
