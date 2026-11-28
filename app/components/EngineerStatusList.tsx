"use client";

import { useScreenParam } from "./screen-params";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { companyNameForDisplay } from "../lib/company-name";
import { engineerHistoryLink } from "../lib/return-path";
import type { Project, Student } from "../types";
import "./engineer-status-list.css";

type CurrentProject = Pick<Project, "id" | "name" | "upperCompany" | "notes" | "primeCompany" | "endCompany" |
  "category" | "participantName" | "executorName" | "followerNames" | "salesName"> & { entryDate: string | null };
type Engineer = Student & { projects: CurrentProject[] };
type Role = "sales" | "leader";
type SelectedProject = { engineer: Engineer; project: CurrentProject };
type LoadResult = { role: Role; attempt: number } & ({ engineers: Engineer[] } | { error: string });
const nameOrder = new Intl.Collator("ja", { numeric: true });
const searchText = (text: string) => text.normalize("NFKC").toLocaleLowerCase("ja").replace(/\s+/gu, "");

function isBackdrop(event: MouseEvent<HTMLDialogElement>) {
  if (event.target !== event.currentTarget) return false;
  const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
  return event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom;
}

function ProjectDetails({ engineer, project, onClose }: SelectedProject & { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressedBackdrop = useRef(false);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const facts = [
    ["面談者名", engineer.name], ["参画者", project.participantName], ["入場日", project.entryDate],
    ["上位会社", companyNameForDisplay(project.upperCompany)], ["元請け", companyNameForDisplay(project.primeCompany)],
    ["エンド企業", companyNameForDisplay(project.endCompany)], ["種類", project.category], ["担当営業", project.salesName],
    ["案件遂行者", project.executorName], ["案件フォロー者", project.followerNames.join("、")],
  ];
  return <dialog className="engineer-status-dialog" ref={ref} aria-labelledby={titleId} onClose={onClose}
    onPointerDown={event => { pressedBackdrop.current = event.isPrimary && event.button === 0 && isBackdrop(event); }}
    onPointerCancel={() => { pressedBackdrop.current = false; }}
    onClick={event => {
      const dismiss = pressedBackdrop.current && isBackdrop(event);
      pressedBackdrop.current = false;
      if (dismiss) event.currentTarget.close();
    }}>
    <div className="engineer-status-dialog-bar">
      <span>案件詳細</span>
      <button type="button" className="engineer-status-action" onClick={() => ref.current?.close()}>一覧に戻る</button>
    </div>
    <div className="engineer-status-dialog-body">
      <h2 className="d-title" id={titleId}>{project.name}</h2>
      <dl className="d-list">{facts.map(([label, value]) => <div className="d-row" key={label}>
        <dt className="d-label">{label}</dt><dd className="d-info">{value || "未登録"}</dd>
      </div>)}</dl>
      <h3>案件概要</h3>
      <p>{project.notes || "案件概要は未登録です。"}</p>
    </div>
  </dialog>;
}

function EngineerNameLink({ engineer, query }: { engineer: Engineer; query: string }) {
  return <Link className="engineer-status-name-link" href={engineerHistoryLink(engineer.id, query)} id={"engineer-" + engineer.id} prefetch={false} title={`${engineer.name}の面談履歴`}>
    {engineer.name}
  </Link>;
}

export default function EngineerStatusList({ role }: { role: Role }) {
  const [query, setQuery] = useScreenParam("engineerQuery");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<LoadResult>();
  const [selected, setSelected] = useState<SelectedProject | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/engineer-status", {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        if (response.status === 401) {
          if (!controller.signal.aborted) window.location.assign("/login");
          return;
        }
        if (response.status === 403) {
          if (!controller.signal.aborted) setResult({ role, attempt, error: "現在のアカウントでは閲覧できません。" });
          return;
        }
        if (!response.ok) throw new Error();
        const body = await response.json() as { engineers: Engineer[] };
        if (!Array.isArray(body.engineers) || !body.engineers.every(person => Array.isArray(person.projects))) throw new Error();
        const engineers = [...body.engineers].sort((a, b) => nameOrder.compare(a.name, b.name));
        if (!controller.signal.aborted) setResult({ role, attempt, engineers });
      } catch {
        if (controller.signal.aborted) return;
        setResult({ role, attempt, error: "参画状況を取得できませんでした。「更新」から再度お試しください。" });
      }
    }
    void load();
    return () => controller.abort();
  }, [role, attempt]);

  const current = result?.role === role && result.attempt === attempt ? result : undefined;
  const engineers = current && "engineers" in current ? current.engineers : undefined;
  const restored = useRef(false);
  useEffect(() => {
    if (!engineers || restored.current || !window.location.hash.startsWith("#engineer-")) return;
    restored.current = true;
    const anchor = document.getElementById(window.location.hash.slice(1));
    anchor?.scrollIntoView({ block: "nearest" });
    anchor?.focus({ preventScroll: true });
  }, [engineers]);
  const needle = searchText(query);
  const visible = (engineers ?? []).flatMap(engineer => {
    if (!needle || searchText(engineer.name).includes(needle)) return [engineer];
    const projects = engineer.projects.filter(project => [project.name, project.upperCompany].some(value => searchText(value).includes(needle)));
    return projects.length ? [{ ...engineer, projects }] : [];
  });
  const assignmentCount = visible.reduce((count, engineer) => count + engineer.projects.length, 0);

  return <section className="engineer-status" aria-label="エンジニアの参画状況">
    <div className="engineer-status-toolbar">
      <label>一覧を検索<input type="search" placeholder="面談者名・参画案件名・上位会社" value={query} onChange={event => setQuery(event.target.value)} /></label>
      {engineers && <p role="status" className="engineer-status-count">表示中 <b>{visible.length}</b>名<span>参画 <b>{assignmentCount}</b>件</span></p>}
      <button type="button" className="engineer-status-action" onClick={() => setAttempt(n => n + 1)} disabled={!current}>更新</button>
    </div>
    {!current ? <p className="engineer-status-message" role="status">参画状況を読み込んでいます…</p>
      : "error" in current ? <p className="engineer-status-message" role="alert">{current.error}</p>
      : !visible.length ? <p className="engineer-status-message" role="status">{current.engineers.length ? "検索条件に一致するエンジニア・案件はありません。" : role === "leader" ? "所属するエンジニアはまだ設定されていません。" : "エンジニアはまだ登録されていません。"}</p>
      : <div className="engineer-status-table-wrap"><table className="engineer-status-table" aria-label="面談者別の参画案件一覧">
        <colgroup><col className="engineer-status-name-col" /><col /><col className="engineer-status-participant-col" /><col className="engineer-status-company-col" /><col className="engineer-status-date-col" /></colgroup>
        <thead><tr><th scope="col">面談者名</th><th scope="col">参画案件名</th><th scope="col">参画者名</th><th scope="col">上位会社</th><th scope="col">入場日</th></tr></thead>
        {visible.map(engineer => <tbody key={engineer.id}>
          {engineer.projects.length ? engineer.projects.map((project, index) => <tr className="engineer-status-active-row" key={project.id}>
            {index === 0 && <th scope="rowgroup" rowSpan={engineer.projects.length}><EngineerNameLink engineer={engineer} query={query} /></th>}
            <td><button type="button" className="engineer-status-project" aria-haspopup="dialog"
              aria-label={engineer.name + "の案件詳細：" + project.name} onClick={event => {
                opener.current = event.currentTarget;
                setSelected({ engineer, project });
              }}><span>{project.name}</span><svg className="icon" aria-hidden="true"><use href="/icons.svg#i-chevright" /></svg></button></td>
            <td data-label="参画者">{project.participantName || "未登録"}</td>
            <td data-label="上位会社">{companyNameForDisplay(project.upperCompany) || "未登録"}</td>
            <td data-label="入場日" className="engineer-status-date">{project.entryDate
              ? <time dateTime={project.entryDate}>{project.entryDate}</time>
              : <span className="engineer-status-unassigned">未登録</span>}</td>
          </tr>) : <tr><th scope="row"><EngineerNameLink engineer={engineer} query={query} /></th><td className="engineer-status-unassigned">参画中の案件なし</td><td className="engineer-status-unassigned">―</td><td className="engineer-status-unassigned">―</td><td className="engineer-status-unassigned">―</td></tr>}
        </tbody>)}
      </table></div>}
    {selected && <ProjectDetails {...selected} onClose={() => {
      setSelected(null);
      opener.current?.focus({ preventScroll: true });
    }} />}
  </section>;
}
