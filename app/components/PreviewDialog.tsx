"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { DashboardData, MutationResult, NotificationPreview } from "../types";
import MultiDatePicker from "./MultiDatePicker";
import "./sales-workflow.css";

export type PreviewDialogKey = { kind: "new" | "confirm" | "entry" | "feedback" | "request" | "notification"; requestId?: string; eventId?: string; notificationId?: string };
type Props = { active: PreviewDialogKey | null; data: DashboardData; onClose: () => void; onSaved: () => Promise<void> };
type Values = Record<string, string>;
type DraftSlot = { key: number; start: string };
type ScheduleMode = "candidates" | "availability";
type Pending = { path: string; payload: unknown; preview: NotificationPreview };
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
function Info({ pairs }: { pairs: [string, ReactNode][] }) { return <dl className="d-list">{pairs.map(([label, value], index) => <div className="d-row" key={`${label}-${index}`}><dt className="d-label">{label}</dt><dd className="d-info">{value}</dd></div>)}</dl>; }
function Field({ title, children }: { title: string; children: ReactNode }) { return <label className="d-label"><span>{title}</span>{children}</label>; }
function Preview({ preview }: { preview: NotificationPreview }) {
  return <><h3 className="sales-preview-title">{preview.title}</h3><Info pairs={preview.lines.map(line => [line.label, /^(http:\/\/127\.0\.0\.1:3100\/|\/(sales|engineer|leader)(\?|$))/.test(line.value) ? <a className="sales-url" href={line.value}>{line.value}</a> : line.value])} />{preview.body && <p className="d-question sales-preserve-lines">{preview.body}</p>}</>;
}

export default function PreviewDialog({ active, data, onClose, onSaved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), opener = useRef<HTMLElement | null>(null), sequence = useRef(2), savingRef = useRef(false);
  const [values, setValues] = useState<Values>({}), [slots, setSlots] = useState<DraftSlot[]>([]), [pending, setPending] = useState<Pending | null>(null), [saved, setSaved] = useState<MutationResult | null>(null), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const [selectedStudents, setSelectedStudents] = useState<string[]>([]);
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("candidates");
  const [requestedDates, setRequestedDates] = useState<string[]>([]);
  const [commonFile, setCommonFile] = useState<File | null>(null);
  const [requestFile, setRequestFile] = useState<File | null>(null);
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
  const attachmentInput = useRef<HTMLInputElement | null>(null);
  const request = data.requests.find(item => item.id === active?.requestId), event = data.events.find(item => item.key === active?.eventId), feedback = data.feedbacks.find(item => item.eventId === active?.eventId), notification = data.notifications.find(item => item.id === active?.notificationId);
  const available = request?.candidates.filter(slot => request.availableSlotIds.includes(slot.id)) ?? [];
  const leaders = data.leaders ?? [];

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!active) { if (element.open) element.close(); return; }
    const targetRequest = data.requests.find(item => item.id === active.requestId), targetEvent = data.events.find(item => item.key === active.eventId);
    setValues({ project: "", summary: "", participantName: "", participantNameKana: "", leaderId: "", slotId: targetRequest?.availableSlotIds[0] ?? "", url: targetEvent?.url ?? "", result: targetEvent?.result === "rejected" ? "rejected" : "passed", when: "2026-11-16T09:00", where: "", memo: "" });
    setSelectedStudents([]); setCommonFile(null); setRequestFile(null); setPreparing(false); preparingRef.current = false;
    setSlots([{ key: 0, start: "2026-11-09T13:00" }, { key: 1, start: "2026-11-10T15:00" }]); sequence.current = 2;
    setScheduleMode("candidates"); setRequestedDates([]);
    setPending(null); setSaved(null); setError(""); setSaving(false); savingRef.current = false;
    if (!element.open) { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; element.showModal(); }
    element.scrollTop = 0; heading.current?.focus({ preventScroll: true });
    // A data refresh must preserve the current form and saved confirmation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  useEffect(() => { if (dialog.current?.open) { dialog.current.scrollTop = 0; heading.current?.focus({ preventScroll: true }); } }, [pending, saved]);

  function input(name: string) {
    const update = (value: string) => setValues(current => ({ ...current, [name]: value }));
    return { name, value: values[name] ?? "", onChange: (e: { currentTarget: { value: string } }) => update(e.currentTarget.value), onInput: (e: { currentTarget: { value: string } }) => update(e.currentTarget.value) };
  }
  function candidateInput(index: number) {
    const update = (start: string) => setSlots(current => current.map((slot, i) => i === index ? { ...slot, start } : slot));
    return { name: `candidate-${index}-start`, value: slots[index]?.start ?? "", onChange: (e: { currentTarget: { value: string } }) => update(e.currentTarget.value), onInput: (e: { currentTarget: { value: string } }) => update(e.currentTarget.value) };
  }
  async function review(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError("");
    const form = new FormData(e.currentTarget), read = (name: string) => String(form.get(name) ?? "").trim(), fields: Values = {};
    form.forEach((value, key) => { if (typeof value === "string") fields[key] = value; }); setValues(current => ({ ...current, ...fields }));
    if (active?.kind === "new") {
      const mode = read("scheduleMode");
      if (mode !== "candidates" && mode !== "availability") { setError("日程の調整方法を選択してください。"); return; }
      const candidates = mode === "candidates" ? slots.map((_, i) => ({ start: read(`candidate-${i}-start`) })) : [];
      const dates = mode === "availability" ? form.getAll("requestedDates").map(String).sort() : [];
      if (mode === "candidates" && !candidates.length) { setError("候補日時を1件以上入力してください。"); return; }
      if (!read("project") || !read("summary")) { setError("案件名と面談概要を入力してください。"); return; }
      if (candidates.some(slot => !validStart(slot.start))) { setError("各候補の開始日時を入力してください。"); return; }
      if (new Set(candidates.map(slot => slot.start)).size !== candidates.length) { setError("同じ開始日時の候補が重複しています。"); return; }
      if (dates.some(date => !validDate(date))) { setError("指定する日付を確認してください。"); return; }
      if (new Set(dates).size !== dates.length) { setError("同じ指定日が重複しています。"); return; }
      const studentIds = form.getAll("studentIds").map(String);
      const students = data.students.filter(item => studentIds.includes(item.id));
      const leader = leaders.find(item => item.id === read("leaderId"));
      if (!leader) { setError("担当リーダーを選択してください。"); return; }
      if (!studentIds.length || students.length !== studentIds.length) { setError("面談者を1名以上選択してください。"); return; }
      const participantName = read("participantName"), participantNameKana = read("participantNameKana").normalize("NFC");
      if (participantName.length > 200 || participantNameKana.length > 200) { setError("参画者はそれぞれ200文字以内で入力してください。"); return; }
      if (participantNameKana && !/^[\u3041-\u3096\u309d\u309eー・　 ]+$/.test(participantNameKana)) { setError("参画者(ひらがな)はひらがなで入力してください。"); return; }
      const invalid = commonFile ? attachmentError(commonFile) : "";
      if (invalid) { setError(invalid); return; }
      if (preparingRef.current) return;
      preparingRef.current = true; setPreparing(true);
      let attachment: { name: string; contentBase64: string } | undefined;
      try { if (commonFile) attachment = { name: commonFile.name, contentBase64: await encodeAttachment(commonFile) }; }
      catch (reason) { setError(reason instanceof Error ? reason.message : "ファイルを読み込めませんでした。"); return; }
      finally { preparingRef.current = false; setPreparing(false); }
      setSelectedStudents(studentIds);
      if (mode === "candidates") setSlots(current => current.map((slot, i) => ({ ...slot, ...candidates[i] })));
      if (mode === "availability") setRequestedDates(dates);
      setPending({ path: "requests", payload: { project: read("project"), summary: read("summary"), leaderId: leader.id, studentIds, participantName, participantNameKana, scheduleMode: mode, requestedDates: dates, candidates, attachment }, preview: { title: "面談依頼の登録・通知内容", lines: [{ label: "案件", value: read("project") }, { label: "概要", value: read("summary") }, { label: "リーダー", value: leader.name }, { label: `面談者 ${students.length}名`, value: students.map(student => student.name).join("\n") }, { label: "参画者", value: participantName || "未登録" }, { label: "参画者(ひらがな)", value: participantNameKana || "未登録" }, { label: "スキルシート", value: commonFile?.name ?? "添付なし" }, { label: "直接の通知先", value: students.map(student => `@${student.name}`).join("\n") }, { label: "日程の調整方法", value: mode === "candidates" ? "候補日時を提示" : "面談者に空き日時を確認" }, { label: mode === "candidates" ? "候補の開始日時" : "指定日", value: mode === "candidates" ? candidates.map(slot => readable(slot.start)).join("\n") : dates.length ? dates.join("\n") : "指定なし（面談者が日付から提案）" }], body: `${mode === "candidates" ? "各面談者が参加可能な候補日時を回答します。" : "各面談者が参加可能な開始日時を提案し、営業が各人の回答から日時を確定します。"}共通のスキルシート1件を選択した面談者に共有します。リーダーは担当案件の状況を閲覧できます。` } });
    } else if (active?.kind === "confirm" && request) {
      const slot = available.find(item => item.id === read("slotId"));
      if (!slot) { setError("受講者が参加可能と回答した候補を選択してください。"); return; }
      setPending({ path: `requests/${encodeURIComponent(request.id)}/confirm`, payload: { slotId: slot.id, url: read("url") }, preview: { title: "面談予定の登録内容", lines: [{ label: "案件", value: request.project }, { label: "面談者", value: request.person }, { label: "参画者", value: request.participantName || "未登録" }, { label: "参画者(ひらがな)", value: request.participantNameKana || "未登録" }, { label: "リーダー", value: request.leaderName || "未設定" }, { label: "面談開始日時", value: readable(slot.start) }, { label: "面談URL", value: read("url") }] } });
    } else if (active?.kind === "entry" && event) {
      const passed = read("result") === "passed";
      setPending({ path: `events/${encodeURIComponent(event.key)}/entry`, payload: { result: read("result"), when: passed ? read("when") : null, where: passed ? read("where") : "", memo: passed ? read("memo") : "" }, preview: { title: passed ? "初回入場予定の登録内容" : "面談結果の登録内容", lines: [{ label: "案件", value: event.project }, { label: "面談者", value: event.person }, { label: "参画者", value: event.participantName || "未登録" }, { label: "参画者(ひらがな)", value: event.participantNameKana || "未登録" }, { label: "リーダー", value: event.leaderName || "未設定" }, { label: "面談結果", value: passed ? "合格" : "不合格" }, ...(passed ? [{ label: "初回入場日時", value: readable(read("when")) }, { label: "集合場所", value: read("where") }, { label: "当日の案内", value: read("memo") || "記載なし" }] : [])] } });
    }
  }
  async function save() {
    if (!pending || savingRef.current) return; savingRef.current = true; setSaving(true); setError("");
    try {
      const response = await fetch(`/api/workflow/${pending.path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pending.payload) });
      const result = await response.json() as MutationResult & { error?: string };
      if (!response.ok) throw new Error(result.error || result.message || "保存できませんでした。入力を確認して再度お試しください。");
      await onSaved(); setSaved(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存できませんでした。"); }
    finally { savingRef.current = false; setSaving(false); }
  }

  async function saveRequestAttachment() {
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
    const invalid = file ? attachmentError(file) : "";
    if (!file && attachmentInput.current) attachmentInput.current.value = "";
    setCommonFile(file && !invalid ? file : null);
    setError(invalid);
  }

  let kicker = "営業の対応", title = "", body: ReactNode = null;
  if (saved) {
    kicker = "保存完了"; title = saved.message;
    body = <><p className="sales-success" role="status">データベースに保存しました。</p>{active?.kind === "new" && pending ? <><Preview preview={pending.preview} />{saved.previews?.length ? <details className="sales-recipient-previews"><summary>保存した通知内容（{saved.previews.length}件）</summary>{saved.previews.map((preview, index) => <div key={index}><Preview preview={preview} /></div>)}</details> : saved.preview && <details className="sales-recipient-previews"><summary>保存した通知内容</summary><Preview preview={saved.preview} /></details>}</> : saved.preview && <Preview preview={saved.preview} />}{active?.kind !== "request" && <p className="d-note">通知・カレンダーの内容はローカルで確認できます。Larkへの送信・予定登録は行っていません。</p>}<button className="d-button" type="button" onClick={() => dialog.current?.close()}>閉じる</button></>;
  } else if (pending) {
    kicker = "保存前の確認"; title = "入力内容を確認";
    body = <><Preview preview={pending.preview} /><p className="d-note">保存すると担当案件へ反映されます。Larkへの送信・予定登録は行いません。日時は日本時間です。</p><div className="sales-dialog-actions"><button className="sales-secondary" type="button" onClick={() => { setPending(null); setError(""); }} disabled={saving}>戻って編集</button><button className="d-button" type="button" onClick={save} disabled={saving}>{saving ? "保存しています…" : "この内容で保存"}</button></div></>;
  } else if (active?.kind === "new") {
    kicker = "面談依頼"; title = "新しい面談依頼を作成";
    body = <><form className="d-fields" onSubmit={review}>
      <Field title="案件名"><input {...input("project")} placeholder="例：販売管理システムの機能追加" required maxLength={200} /></Field>
      <Field title="面談概要"><textarea {...input("summary")} rows={3} placeholder="案件内容や面談で確認したいこと" required /></Field>
      <Field title="担当リーダー"><select {...input("leaderId")} aria-label="担当リーダー" required><option value="" disabled>担当リーダーを選択</option>{leaders.map(leader => <option value={leader.id} key={leader.id}>{leader.name}</option>)}</select></Field>
      <fieldset className="sales-members" aria-describedby="sales-members-note"><legend>面談者 <span>複数選択可</span></legend><p id="sales-members-note" className="sales-field-note">1名以上選択してください。依頼・回答・面談結果は一人ずつ管理します。</p><div className="sales-member-options">{data.students.map(student => <label className="sales-member-option" key={student.id}><input type="checkbox" name="studentIds" value={student.id} disabled={preparing} checked={selectedStudents.includes(student.id)} onChange={e => { const checked = e.currentTarget.checked; setSelectedStudents(current => checked ? current.includes(student.id) ? current : [...current, student.id] : current.filter(id => id !== student.id)); }} /><span>{student.name}</span></label>)}</div><p className="sales-member-count" aria-live="polite">選択 {selectedStudents.length}名</p></fieldset>
      <Field title="参画者"><input {...input("participantName")} maxLength={200} placeholder="例：山田 太郎" /></Field>
      <Field title="参画者(ひらがな)"><input {...input("participantNameKana")} maxLength={200} placeholder="例：やまだ たろう" /></Field>
      <p className="sales-field-note">実際に参画する方を入力してください。面談者と異なる方も登録できます。</p>
      <fieldset className="sales-attachments"><legend>スキルシート（任意・1ファイル）</legend><p className="sales-field-note">この依頼で共通の1ファイルを、選択したすべての面談者に共有します。PDF・Excel・Word、5MB以下。</p><div className="sales-attachment-item"><label htmlFor="skill-common">共通のスキルシート</label><input id="skill-common" ref={attachmentInput} disabled={preparing} type="file" accept={attachmentAccept} onChange={e => { const file = e.currentTarget.files?.[0] ?? null; selectAttachment(file); if (file && attachmentError(file)) e.currentTarget.value = ""; }} /><span>{commonFile ? `選択中：${commonFile.name}` : "添付なし"}</span>{commonFile && <button type="button" className="text-link" onClick={() => selectAttachment(null)}>添付を解除</button>}</div></fieldset>
      <fieldset className="sales-scheduling"><legend>日程の調整方法</legend><div className="sales-scheduling-options"><label><input type="radio" name="scheduleMode" value="candidates" checked={scheduleMode === "candidates"} disabled={preparing} onChange={() => { setScheduleMode("candidates"); setError(""); }} /><span><strong>候補日時を提示する</strong><small>営業が開始日時を指定し、面談者が選びます。</small></span></label><label><input type="radio" name="scheduleMode" value="availability" checked={scheduleMode === "availability"} disabled={preparing} onChange={() => { setScheduleMode("availability"); setError(""); }} /><span><strong>面談者に空き日時を確認する</strong><small>面談者から参加可能な開始日時を提案してもらいます。</small></span></label></div></fieldset>
      {scheduleMode === "candidates" ? <><p className="sales-field-note">面談の開始日時を入力してください。</p>{slots.map((slot, i) => <fieldset className="sales-slot" key={slot.key}><legend>候補日時 {i + 1}</legend><Field title={`候補 ${i + 1} の開始日時`}><input {...candidateInput(i)} type="datetime-local" required disabled={preparing} /></Field><button type="button" className="text-link" disabled={slots.length <= 1 || preparing} onClick={() => setSlots(current => current.filter(item => item.key !== slot.key))}>この候補を削除</button></fieldset>)}<button type="button" className="sales-secondary" disabled={preparing} onClick={() => setSlots(current => [...current, { key: sequence.current++, start: "" }])}>＋ 候補日時を追加</button></> : <fieldset className="sales-requested-dates"><legend>日付の指定（任意）</legend><p className="sales-field-note">カレンダーから複数の日付を選択できます。同じ日付をもう一度押すと解除できます。日付を指定しない場合は、面談者が日付から提案します。</p><MultiDatePicker value={requestedDates} onChange={setRequestedDates} disabled={preparing} /></fieldset>}
      <button className="d-button" type="submit" disabled={!data.students.length || !leaders.length || preparing}>{preparing ? "ファイルを読み込み中…" : "依頼内容・Lark通知を確認"}</button></form><p className="d-note">各面談者が自分のホームから回答し、営業が各人の面談開始日時・URLを直接共有します。リーダーは状況を閲覧できます。日時は日本時間です。</p>{!leaders.length && <p className="sales-error" role="alert">担当リーダーを取得できません。最新の一覧を読み込んでください。</p>}</>;
  } else if (active?.kind === "confirm" && request) {
    title = "面談日時を確定";
    body = <><Info pairs={[["案件", request.project], ["面談者", request.person], ["参画者", request.participantName || "未登録"], ["参画者(ひらがな)", request.participantNameKana || "未登録"], ["リーダー", request.leaderName || "未設定"]]} />{request.scheduleMode === "availability" && <Info pairs={[["日程の調整方法", "面談者に空き日時を確認"], ["指定日", request.requestedDates.length ? request.requestedDates.join("\n") : "指定なし"]]} />}{available.length ? <form className="d-fields" onSubmit={review}><Field title="回答済みの開始日時"><select {...input("slotId")} aria-label="回答済みの開始日時" required>{available.map(slot => <option key={slot.id} value={slot.id}>{readable(slot.start)}</option>)}</select></Field><Field title="面談URL"><input {...input("url")} type="url" pattern="https?://.+" placeholder="https://…" required /></Field><button className="d-button" type="submit">面談予定・カレンダー内容を確認</button></form> : <p className="d-note">{request.scheduleMode === "availability" ? "面談者から参加可能な開始日時の提案を待っています。" : "面談者から参加可能な日時の回答を待っています。"}</p>}</>;
  } else if (active?.kind === "entry" && event) {
    title = "面談結果・初回入場を登録";
    body = <><Info pairs={[["案件", event.project], ["面談者", event.person], ["参画者", event.participantName || "未登録"], ["参画者(ひらがな)", event.participantNameKana || "未登録"], ["リーダー", event.leaderName || "未設定"]]} /><form className="d-fields" onSubmit={review}><Field title="面談結果"><select {...input("result")} aria-label="面談結果"><option value="passed">合格</option><option value="rejected">不合格</option></select></Field>{values.result !== "rejected" && <><Field title="初回入場日時"><input {...input("when")} type="datetime-local" required /></Field><Field title="集合場所"><input {...input("where")} placeholder="例：本社ビル 1階受付" required /></Field><Field title="当日の案内"><textarea {...input("memo")} rows={3} placeholder="持ち物・受付方法など" /></Field></>}<button className="d-button" type="submit">登録内容を確認</button></form><p className="d-note">不合格の場合、初回入場の予定は作成しません。</p></>;
  } else if (active?.kind === "feedback" && event) {
    title = "面談所感・提出状況";
    body = <><Info pairs={[["案件", event.project], ["面談者", event.person], ["参画者", event.participantName || "未登録"], ["参画者(ひらがな)", event.participantNameKana || "未登録"], ["リーダー", event.leaderName || "未設定"], ["提出状況", feedback ? "提出済み" : "受講者の入力待ち"]]} />{feedback ? <><Info pairs={[["業務内容", feedback.duties], ["作業工程", feedback.process], ["リモート頻度", feedback.remote], ["感想", feedback.impression]]} /><h3 className="d-label">聞かれた質問</h3>{feedback.questions.map((question, i) => <p className="d-question" key={i}>Q{i + 1}　{question}</p>)}</> : <><p className="d-info">受講者が業務内容・作業工程・リモート頻度・感想・聞かれた質問を記入する段階です。</p><p className="d-note">受講者ホームで所感を提出すると、この画面へ反映されます。</p></>}</>;
  } else if (active?.kind === "request" && request) {
    title = "面談依頼の状況";
    body = <>
      <Info pairs={[["案件", request.project], ["面談者", request.person], ["参画者", request.participantName || "未登録"], ["参画者(ひらがな)", request.participantNameKana || "未登録"], ["リーダー", request.leaderName || "未設定"], ["概要", request.summary], ["状況", { requested: "受講者の回答待ち", responded: "回答済み・日時確定待ち", confirmed: "日時確定済み" }[request.status]], ["日程の調整方法", request.scheduleMode === "availability" ? "面談者に空き日時を確認" : "候補日時を提示"]]} />
      {request.scheduleMode === "availability" && <Info pairs={[["指定日", request.requestedDates.length ? request.requestedDates.join("\n") : "指定なし"]]} />}
      <section className="sales-attachments"><h3>スキルシート{request.attachment?.scope === "request" ? "（以前の個別添付）" : "（共通・1ファイル）"}</h3>{request.attachment ? <p><a className="sales-url" href={`/api/requests/${encodeURIComponent(request.id)}/attachment`} download>{request.attachment.name} をダウンロード</a></p> : <p className="sales-field-note">添付はありません。</p>}<label htmlFor="request-skill">{request.attachment ? "差し替えるファイル" : "添付するファイル"}</label><input id="request-skill" type="file" disabled={saving} accept={attachmentAccept} onChange={e => { const file = e.currentTarget.files?.[0] ?? null; const invalid = file ? attachmentError(file) : ""; setRequestFile(invalid ? null : file); setError(invalid); if (invalid) e.currentTarget.value = ""; }} />{requestFile && <p className="sales-field-note">選択中：{requestFile.name}</p>}<p className="sales-field-note">PDF・Excel・Word、5MB以下。この案件のすべての面談者に共有されます。</p>{request.attachment?.scope === "request" && <p className="sales-field-note">以前の個別添付は自動共有していません。ここで保存すると、案件共通の1ファイルとしてすべての面談者に共有されます。</p>}<button className="sales-secondary" type="button" disabled={!requestFile || saving} onClick={saveRequestAttachment}>{saving ? "保存しています…" : request.attachment ? "差し替えを保存" : "添付を保存"}</button></section>
      <h3 className="d-label">{request.scheduleMode === "availability" ? "提案された開始日時" : "候補の開始日時と回答"}</h3>
      {request.candidates.length ? request.candidates.map(slot => <p className="d-question" key={slot.id}>{readable(slot.start)}<br /><strong>{request.confirmedSlotId === slot.id ? "確定" : request.availableSlotIds.includes(slot.id) ? "参加可能" : request.status === "requested" ? "回答待ち" : "選択なし"}</strong></p>) : <p className="d-note">面談者から参加可能な開始日時の提案を待っています。</p>}
    </>;
  } else if (active?.kind === "notification" && notification) {
    kicker = notification.kind === "calendar" ? "カレンダー登録内容" : "Lark通知内容"; title = "保存済みの通知プレビュー";
    body = <><Preview preview={notification} /><p className="d-note">ローカルで保存した送信内容です。外部サービスには送信していません。</p></>;
  } else if (active) { title = "対象を確認できません"; body = <p className="d-note">最新の一覧へ戻り、もう一度選択してください。</p>; }

  return <dialog ref={dialog} aria-labelledby="modal-title" onCancel={e => { if (saving || preparing) e.preventDefault(); }} onClose={() => { setCommonFile(null); setRequestFile(null); setPending(null); setSaved(null); onClose(); const target = opener.current?.isConnected ? opener.current : document.getElementById("tab-title"); target?.focus({ preventScroll: true }); }} onClick={e => { if (saving || preparing || e.target !== e.currentTarget) return; const bounds = e.currentTarget.getBoundingClientRect(); if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) e.currentTarget.close(); }}><div className="dialog-chrome"><strong>DealHunter</strong><button type="button" aria-label="閉じる" disabled={saving || preparing} onClick={() => dialog.current?.close()}><svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div><div id="detail-body"><div className="d-kicker">{kicker}</div><h2 className="d-title" id="modal-title" ref={heading} tabIndex={-1}>{title}</h2>{error && <p className="sales-error" role="alert">{error}</p>}{body}</div></dialog>;
}
