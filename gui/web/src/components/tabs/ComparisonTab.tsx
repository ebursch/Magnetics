// Compare view — the rotating-mode (MODESPEC) and quasi-stationary (SLCONTOUR) main
// plots stacked on ONE shared time axis, plus user annotations (vertical lines, time
// spans, horizontal levels, points) for marking events across both analyses.
//
// Data: the same nodes the Rotating / Quasi-stationary tabs fetch, with the params
// those tabs last ran (store.rotParams / store.qsParams) — or their defaults when a tab
// hasn't been opened yet — so this view always shows the analysis the user tuned.
import { useCallback, useMemo, useRef, useState } from "react";
import type Plotly from "plotly.js-dist-min";
import { useStore } from "../../store";
import { useNode } from "../../lib/useNode";
import Plot from "../../lib/Plot";
import type { ContourNode, HeatmapNode, LineNode, Node } from "../../lib/contract";
import { MODE_PALETTE, plotChrome } from "../../lib/colormaps";
import { QS_MODE_PALETTE, lineTraces, phiTimeTraces, spectrogramTrace } from "../../lib/plotTraces";
import { QS_DEFAULTS, phiPeak } from "../../lib/qsTransforms";
import { ROT_DEFAULTS, rotFetchParams } from "../../lib/rotatingTransforms";
import {
  ANNOTATION_COLORS, DEFAULT_COLOR, annotationsToPlotly, parseAnnotations,
  type Annotation, type AnnotationInput, type AnnotationKind, type AnnotationPatch, type PanelId,
} from "../../lib/annotations";
import { buildCompareFigure, panelForAxis, timeExtents, type PanelSpec } from "../../lib/compareLayout";

const PANEL_LABEL: Record<PanelId, string> = {
  spec: "Spectrogram",
  mode_over_time: "n(t)",
  phi_t: "δBp(φ, t)",
  amplitude: "QS amplitude",
  phase: "QS phase",
};
const PANEL_WEIGHT: Record<PanelId, number> = {
  spec: 1.5, mode_over_time: 0.7, phi_t: 1.3, amplitude: 0.9, phase: 0.9,
};
// Display order, top → bottom: rotating analyses first, then quasi-stationary.
const PANEL_ORDER: PanelId[] = ["spec", "mode_over_time", "phi_t", "amplitude", "phase"];
const DEFAULT_PANELS: PanelId[] = ["spec", "phi_t", "amplitude", "phase"];

type ClickMode = "cursor" | AnnotationKind;
const CLICK_MODES: { id: ClickMode; label: string; hint: string }[] = [
  { id: "cursor", label: "Cursor", hint: "Click sets the shared time cursor" },
  { id: "vline", label: "V-line", hint: "Click adds a vertical time marker through every panel" },
  { id: "span", label: "Span", hint: "Click twice to shade a time window across every panel" },
  { id: "hline", label: "H-line", hint: "Click adds a horizontal level on the clicked panel" },
  { id: "point", label: "Point", hint: "Click adds a marker at the clicked (t, y) on that panel" },
];
const KIND_LABEL: Record<AnnotationKind, string> = { vline: "V-line", span: "Span", hline: "H-line", point: "Point" };

const errText = (e: string | null) => e?.replace(/^Error:\s*fetch failed \(\d+\):\s*/, "") ?? null;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Number(v.toPrecision(4));

export default function ComparisonTab({ machine }: { machine: string }) {
  const theme = useStore((s) => s.theme);
  const cursorMs = useStore((s) => s.cursorMs);
  const setCursorMs = useStore((s) => s.setCursorMs);
  const rotParams = useStore((s) => s.rotParams);
  const qsParams = useStore((s) => s.qsParams);
  const annotationsAll = useStore((s) => s.annotations);
  const addAnnotation = useStore((s) => s.addAnnotation);
  const updateAnnotation = useStore((s) => s.updateAnnotation);
  const removeAnnotation = useStore((s) => s.removeAnnotation);
  const setAnnotations = useStore((s) => s.setAnnotations);
  const annotations = useMemo(() => annotationsAll[machine] ?? [], [annotationsAll, machine]);

  const [panels, setPanels] = useState<Set<PanelId>>(new Set(DEFAULT_PANELS));
  const [specMode, setSpecMode] = useState<"n" | "power">("n");
  const [clickMode, setClickMode] = useState<ClickMode>("cursor");
  const [pendingSpan, setPendingSpan] = useState<number | null>(null);
  const [xRange, setXRange] = useState<[number, number] | null>(null);
  const [panelPx, setPanelPx] = useState(170);

  const on = (p: PanelId) => panels.has(p);
  const togglePanel = (p: PanelId) =>
    setPanels((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });

  // ── Data — only enabled panels fetch (a null machine suppresses useNode) ──
  const rot = useMemo(() => rotParams ?? rotFetchParams(ROT_DEFAULTS), [rotParams]);
  const qs = useMemo<Record<string, string>>(() => qsParams ?? { ...QS_DEFAULTS }, [qsParams]);
  const m = (p: PanelId, cond = true) => (on(p) && cond ? machine : null);

  const spec = useNode(m("spec", specMode === "power"), "spectrogram", rot.spec);
  const modeNum = useNode(m("spec", specMode === "n"), "mode_number", rot.mode);
  const modeOverTime = useNode(m("mode_over_time"), "mode_over_time");
  const phiT = useNode(m("phi_t"), "phi_t", qs);
  const amp = useNode(m("amplitude"), "amplitude", qs);
  const phase = useNode(m("phase"), "phase_t", qs);
  const specRes = specMode === "n" ? modeNum : spec;

  const fetched: Record<PanelId, { node: Node | null; error: string | null; loading: boolean }> = {
    spec: specRes, mode_over_time: modeOverTime, phi_t: phiT, amplitude: amp, phase,
  };

  // ── Panels → one stacked figure ───────────────────────────────────
  const panelSpecs = useMemo((): PanelSpec[] => {
    const out: PanelSpec[] = [];
    for (const id of PANEL_ORDER) {
      if (!panels.has(id)) continue;
      if (id === "spec" && specRes.node?.kind === "heatmap") {
        const n = specRes.node as HeatmapNode;
        // Same treatment as the Rotating tab: [-0.5,6.5] aligns the |n| palette to integers.
        const shown = specMode === "n"
          ? { ...n, discrete: true, zrange: [-0.5, 6.5] as [number, number] }
          : { ...n, discrete: false, zrange: undefined };
        out.push({
          id, weight: PANEL_WEIGHT[id], traces: [spectrogramTrace(shown)],
          yaxis: { title: { text: n.axes.y }, range: [rot.spec.fmin ?? ROT_DEFAULTS.fmin, rot.spec.fmax ?? ROT_DEFAULTS.fmax] },
        });
      } else if (id === "mode_over_time" && modeOverTime.node?.kind === "line") {
        const n = modeOverTime.node as LineNode;
        out.push({
          id, weight: PANEL_WEIGHT[id], traces: lineTraces(n, { palette: MODE_PALETTE.slice(1) }),
          yaxis: { title: { text: n.axes.y } },
        });
      } else if (id === "phi_t" && phiT.node?.kind === "contour") {
        const n = phiT.node as ContourNode;
        out.push({
          id, weight: PANEL_WEIGHT[id], traces: phiTimeTraces(n, phiPeak(n.z, n.y)),
          yaxis: { title: { text: n.axes.y }, range: [0, 360], tickvals: [0, 90, 180, 270, 360] },
        });
      } else if (id === "amplitude" && amp.node?.kind === "line") {
        const n = amp.node as LineNode;
        out.push({
          id, weight: PANEL_WEIGHT[id], legend: String(n.meta?.legend_title ?? "n"),
          traces: lineTraces(n, { palette: QS_MODE_PALETTE }),
          yaxis: { title: { text: n.axes.y }, rangemode: "tozero" },
        });
      } else if (id === "phase" && phase.node?.kind === "line") {
        const n = phase.node as LineNode;
        out.push({
          id, weight: PANEL_WEIGHT[id],
          traces: lineTraces(n, { visible: n.meta?.phase_visible as boolean[] | undefined, palette: QS_MODE_PALETTE }),
          yaxis: { title: { text: n.axes.y }, range: [-180, 180], tickvals: [-180, -90, 0, 90, 180] },
        });
      }
    }
    return out;
  }, [panels, specRes.node, specMode, modeOverTime.node, phiT.node, amp.node, phase.node, rot]);

  const extents = useMemo(
    () => timeExtents(panelSpecs.flatMap((p) => p.traces.map((t) => t.x as number[] | undefined))),
    [panelSpecs],
  );

  const chrome = plotChrome(theme);
  const accent = theme === "dark" ? "#2ee6cf" : "#0a8d80"; // literal --accent (Plotly can't read CSS vars)

  const figure = useMemo(() => {
    const fig = buildCompareFigure(panelSpecs, {
      chrome,
      xTitle: "time (ms)",
      xRange,
      uirevision: `${machine}:${panelSpecs.map((p) => p.id).join(",")}:${specMode}`,
    });
    const ann = annotationsToPlotly(annotations, fig.axisOf, chrome.font.color);
    const shapes: Partial<Plotly.Shape>[] = [...ann.shapes];
    // Shared time cursor (same look as the Rotating tab's), and the first edge of a span in progress.
    if (extents.union && cursorMs >= extents.union[0] && cursorMs <= extents.union[1]) {
      shapes.push({
        type: "line", xref: "x", yref: "paper", x0: cursorMs, x1: cursorMs, y0: 0, y1: 1,
        line: { color: accent, width: 2, dash: "dash" },
      });
    }
    if (pendingSpan != null) {
      shapes.push({
        type: "line", xref: "x", yref: "paper", x0: pendingSpan, x1: pendingSpan, y0: 0, y1: 1,
        line: { color: DEFAULT_COLOR.span, width: 1, dash: "dot" },
      });
    }
    return {
      axisOf: fig.axisOf,
      data: [...fig.data, ...ann.traces],
      layout: { ...fig.layout, shapes, annotations: ann.annotations } as Partial<Plotly.Layout>,
    };
  }, [panelSpecs, chrome, xRange, machine, specMode, annotations, extents.union, cursorMs, pendingSpan, accent]);

  // ── Interaction ───────────────────────────────────────────────────
  const onClick = useCallback((e: Plotly.PlotMouseEvent) => {
    const pt = e.points?.[0];
    if (!pt || typeof pt.x !== "number") return;
    const t = r2(pt.x);
    const y = typeof pt.y === "number" ? r4(pt.y) : null;
    const panel = panelForAxis(figure.axisOf, (pt.data as { yaxis?: string }).yaxis);
    switch (clickMode) {
      case "cursor":
        setCursorMs(t);
        break;
      case "vline":
        addAnnotation(machine, { kind: "vline", t });
        break;
      case "span":
        if (pendingSpan == null) setPendingSpan(t);
        else {
          if (t !== pendingSpan)
            addAnnotation(machine, { kind: "span", t0: Math.min(pendingSpan, t), t1: Math.max(pendingSpan, t) });
          setPendingSpan(null);
        }
        break;
      case "hline":
        if (panel && y != null) addAnnotation(machine, { kind: "hline", panel, y });
        break;
      case "point":
        if (panel && y != null) addAnnotation(machine, { kind: "point", panel, t, y });
        break;
    }
  }, [clickMode, figure.axisOf, machine, pendingSpan, setCursorMs, addAnnotation]);

  const onRelayout = useCallback((e: Record<string, unknown>) => {
    if (e["xaxis.autorange"] === true) setXRange(null);
    else if (e["xaxis.range[0]"] != null) setXRange([Number(e["xaxis.range[0]"]), Number(e["xaxis.range[1]"])]);
    else if (Array.isArray(e["xaxis.range"])) {
      const [a, b] = e["xaxis.range"] as number[];
      setXRange([Number(a), Number(b)]);
    }
  }, []);

  const height = Math.max(260, panelSpecs.reduce((a, p) => a + (p.weight ?? 1), 0) * panelPx + 90);

  // ── Status of each enabled panel (loading / unavailable) ─────────
  const status = PANEL_ORDER.filter(on).flatMap((p) => {
    const f = fetched[p];
    if (f.node) return [];
    const err = errText(f.error);
    return [{ p, text: err ? `unavailable — ${err}` : "loading…", err: !!err }];
  });

  const source = (
    <span className="cmp-dim">
      rotating: {rotParams ? "Rotating-tab settings" : "defaults"} · quasi-stationary:{" "}
      {qsParams ? "last QS-tab fit" : "defaults (shot time window)"}
    </span>
  );

  return (
    <div className="card cmp" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="cmp-toolbar">
        <span className="metrics-title">Panels</span>
        {PANEL_ORDER.map((p) => (
          <label key={p} className="cmp-check">
            <input type="checkbox" checked={on(p)} onChange={() => togglePanel(p)} /> {PANEL_LABEL[p]}
          </label>
        ))}
        <span className="cmp-sep" />
        <div className="seg" role="group" aria-label="Spectrogram view">
          <button type="button" className={`seg-btn${specMode === "n" ? " active" : ""}`} aria-pressed={specMode === "n"}
            onClick={() => setSpecMode("n")}>Mode n</button>
          <button type="button" className={`seg-btn${specMode === "power" ? " active" : ""}`} aria-pressed={specMode === "power"}
            onClick={() => setSpecMode("power")}>Log Power</button>
        </div>
      </div>

      <div className="cmp-toolbar">
        <span className="metrics-title">Click to add</span>
        <div className="seg" role="group" aria-label="Click mode">
          {CLICK_MODES.map((c) => (
            <button key={c.id} type="button" title={c.hint} aria-pressed={clickMode === c.id}
              className={`seg-btn${clickMode === c.id ? " active" : ""}`}
              onClick={() => { setClickMode(c.id); setPendingSpan(null); }}>
              {c.label}
            </button>
          ))}
        </div>
        {pendingSpan != null && <span className="cmp-dim">span from {pendingSpan} ms — click the other edge</span>}
        <span className="cmp-sep" />
        <span className="metrics-title">Time axis</span>
        <button type="button" className="seg-btn" onClick={() => setXRange(null)} title="Union of every panel's time range">
          Full
        </button>
        <button type="button" className="seg-btn" disabled={!extents.overlap}
          onClick={() => extents.overlap && setXRange(extents.overlap)}
          title="Only the time range where every shown panel has data">
          Overlap
        </button>
        <label className="cmp-check" title="Height per panel">
          height
          <input type="range" min={110} max={320} step={10} value={panelPx}
            onChange={(e) => setPanelPx(Number(e.target.value))} />
        </label>
      </div>

      <div className="cmp-dim-row">
        {source}
        {status.map((s) => (
          <span key={s.p} className={s.err ? "cmp-warn" : "cmp-dim"}>· {PANEL_LABEL[s.p]}: {s.text}</span>
        ))}
      </div>

      {panelSpecs.length ? (
        <Plot data={figure.data} layout={figure.layout} height={height}
          onClick={onClick} onRelayout={onRelayout} exportName={`shot_${machine}_compare`} />
      ) : (
        <div className="placeholder">{panels.size ? "Loading…" : "Select at least one panel."}</div>
      )}

      <AnnotationEditor
        machine={machine}
        annotations={annotations}
        visiblePanels={panelSpecs.map((p) => p.id)}
        cursorMs={cursorMs}
        onAdd={(a) => addAnnotation(machine, a)}
        onUpdate={(id, patch) => updateAnnotation(machine, id, patch)}
        onRemove={(id) => removeAnnotation(machine, id)}
        onReplace={(list) => setAnnotations(machine, list)}
      />
    </div>
  );
}

// ── Annotation list + numeric add form ────────────────────────────────

/** A number box that commits on blur / Enter, so partial input ("-", "1e") never
 *  writes NaN into the store. */
function NumField({ value, onCommit, width = 72, label }: {
  value: number; onCommit: (v: number) => void; width?: number; label: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text == null) return;
    const v = Number(text);
    if (text.trim() !== "" && Number.isFinite(v)) onCommit(v);
    setText(null);
  };
  return (
    <input className="cmp-input" aria-label={label} style={{ width }} value={text ?? String(value)}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}

function ColorPick({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <span className="cmp-swatches">
      {ANNOTATION_COLORS.map((c) => (
        <button key={c} type="button" aria-label={`color ${c}`} aria-pressed={c === value}
          className={`cmp-swatch${c === value ? " active" : ""}`} style={{ background: c }}
          onClick={() => onChange(c)} />
      ))}
    </span>
  );
}

function AnnotationEditor({
  machine, annotations, visiblePanels, cursorMs, onAdd, onUpdate, onRemove, onReplace,
}: {
  machine: string;
  annotations: Annotation[];
  visiblePanels: PanelId[];
  cursorMs: number;
  onAdd: (a: AnnotationInput) => void;
  onUpdate: (id: string, patch: AnnotationPatch) => void;
  onRemove: (id: string) => void;
  onReplace: (list: Annotation[]) => void;
}) {
  const [kind, setKind] = useState<AnnotationKind>("vline");
  const [t, setT] = useState("");
  const [t1, setT1] = useState("");
  const [y, setY] = useState("");
  const [panel, setPanel] = useState<PanelId | "">("");
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const usePanel = kind === "hline" || kind === "point";
  const tVal = t.trim() === "" ? cursorMs : Number(t);
  const effPanel: PanelId | "" = panel && visiblePanels.includes(panel) ? panel : (visiblePanels.at(0) ?? "");
  const valid =
    Number.isFinite(tVal) &&
    (kind !== "span" || (t1.trim() !== "" && Number.isFinite(Number(t1)) && Number(t1) !== tVal)) &&
    (!usePanel || (effPanel !== "" && y.trim() !== "" && Number.isFinite(Number(y))));

  const add = () => {
    if (!valid) return;
    const base = { ...(label ? { label } : {}), color: color ?? DEFAULT_COLOR[kind] };
    if (kind === "vline") onAdd({ kind, t: tVal, ...base });
    else if (kind === "span") onAdd({ kind, t0: Math.min(tVal, Number(t1)), t1: Math.max(tVal, Number(t1)), ...base });
    else if (kind === "hline") onAdd({ kind, panel: effPanel as PanelId, y: Number(y), ...base });
    else onAdd({ kind, panel: effPanel as PanelId, t: tVal, y: Number(y), ...base });
    setLabel("");
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ machine, annotations }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shot_${machine}_annotations.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const importJson = async (f: File) => {
    try {
      const raw: unknown = JSON.parse(await f.text());
      const list = parseAnnotations(Array.isArray(raw) ? raw : (raw as { annotations?: unknown })?.annotations);
      const have = new Set(annotations.map((a) => a.id));
      const added = list.filter((a) => !have.has(a.id));
      onReplace([...annotations, ...added]);
      setImportMsg(`imported ${added.length} annotation${added.length === 1 ? "" : "s"}`);
    } catch (e) {
      setImportMsg(`import failed: ${String(e)}`);
    }
  };

  return (
    <div className="cmp-ann">
      <div className="cmp-toolbar">
        <span className="metrics-title">Annotations ({annotations.length})</span>
        <span className="cmp-sep" />
        <button type="button" className="seg-btn" onClick={exportJson} disabled={!annotations.length}>Export JSON</button>
        <button type="button" className="seg-btn" onClick={() => fileRef.current?.click()}>Import JSON</button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.target.value = ""; }} />
        <button type="button" className="seg-btn" disabled={!annotations.length}
          onClick={() => { if (window.confirm(`Remove all ${annotations.length} annotations for this shot?`)) onReplace([]); }}>
          Clear all
        </button>
        {importMsg && <span className="cmp-dim">{importMsg}</span>}
      </div>

      <div className="cmp-toolbar" role="group" aria-label="Add annotation">
        <select className="cmp-input" aria-label="annotation kind" value={kind}
          onChange={(e) => setKind(e.target.value as AnnotationKind)}>
          {(Object.keys(KIND_LABEL) as AnnotationKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        {kind !== "hline" && (
          <label className="cmp-check">{kind === "span" ? "t₀" : "t"} (ms)
            <input className="cmp-input" style={{ width: 80 }} aria-label="time" placeholder={`${r2(cursorMs)} (cursor)`}
              value={t} onChange={(e) => setT(e.target.value)} />
          </label>
        )}
        {kind === "span" && (
          <label className="cmp-check">t₁ (ms)
            <input className="cmp-input" style={{ width: 80 }} aria-label="end time" value={t1} onChange={(e) => setT1(e.target.value)} />
          </label>
        )}
        {usePanel && (
          <>
            <select className="cmp-input" aria-label="panel" value={effPanel}
              onChange={(e) => setPanel(e.target.value as PanelId)}>
              {visiblePanels.map((p) => <option key={p} value={p}>{PANEL_LABEL[p]}</option>)}
            </select>
            <label className="cmp-check">y
              <input className="cmp-input" style={{ width: 72 }} aria-label="y value" value={y} onChange={(e) => setY(e.target.value)} />
            </label>
          </>
        )}
        <input className="cmp-input" style={{ width: 140 }} aria-label="label" placeholder="label (optional)"
          value={label} onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <ColorPick value={color ?? DEFAULT_COLOR[kind]} onChange={setColor} />
        <button type="button" className="seg-btn active" disabled={!valid} onClick={add}>Add</button>
      </div>

      {annotations.length > 0 && (
        <table className="cmp-table">
          <thead>
            <tr><th>kind</th><th>panel</th><th>t / t₀ (ms)</th><th>t₁ (ms)</th><th>y</th><th>label</th><th>color</th><th /></tr>
          </thead>
          <tbody>
            {annotations.map((a) => (
              <tr key={a.id}>
                <td>{KIND_LABEL[a.kind]}</td>
                <td>{a.kind === "hline" || a.kind === "point" ? PANEL_LABEL[a.panel] : "all"}</td>
                <td>
                  {a.kind === "vline" || a.kind === "point" ? (
                    <NumField label="time" value={a.t} onCommit={(v) => onUpdate(a.id, { t: v })} />
                  ) : a.kind === "span" ? (
                    <NumField label="start time" value={a.t0} onCommit={(v) => onUpdate(a.id, { t0: Math.min(v, a.t1), t1: Math.max(v, a.t1) })} />
                  ) : "—"}
                </td>
                <td>
                  {a.kind === "span"
                    ? <NumField label="end time" value={a.t1} onCommit={(v) => onUpdate(a.id, { t0: Math.min(v, a.t0), t1: Math.max(v, a.t0) })} />
                    : "—"}
                </td>
                <td>
                  {a.kind === "hline" || a.kind === "point"
                    ? <NumField label="y value" value={a.y} onCommit={(v) => onUpdate(a.id, { y: v })} />
                    : "—"}
                </td>
                <td>
                  <input className="cmp-input" style={{ width: 140 }} aria-label="label" value={a.label ?? ""}
                    onChange={(e) => onUpdate(a.id, { label: e.target.value })} />
                </td>
                <td><ColorPick value={a.color ?? DEFAULT_COLOR[a.kind]} onChange={(c) => onUpdate(a.id, { color: c })} /></td>
                <td>
                  <button type="button" className="cmp-del" aria-label="delete annotation" title="Delete"
                    onClick={() => onRemove(a.id)}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
