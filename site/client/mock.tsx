// A faithful, static rendering of the sift review UI with an invented example change, so the page
// can show the product without screenshots of anyone's real code.

type Tok = [string, string?];
const L = (...toks: Tok[]) => toks.map(([t, c], i) => (c ? <span key={i} className={c}>{t}</span> : t));

const Mark = () => (
  <svg viewBox="0 0 32 32" width="16" height="16" aria-hidden="true">
    <path d="M6 9h20M6 16h13M6 23h7" stroke="var(--k-important)" stroke-width="3.2" stroke-linecap="round" />
  </svg>
);

type Row = { o?: number; n?: number; t: " " | "+" | "-"; code: Tok[]; mk?: string };

const rows: Row[] = [
  { o: 41, n: 41, t: " ", code: [["  "], ["/** Adds an item, stacking onto existing stacks first. */", "cm"]] },
  { o: 42, t: "-", code: [["  "], ["add", "fn"], ["(item: "], ["Item", "ty"], ["): "], ["boolean", "ty"], [" {"]] },
  { n: 42, t: "+", code: [["  "], ["add", "fn"], ["(item: "], ["Item", "ty"], ["): "], ["number", "ty"], [" {"]], mk: "var(--k-important)" },
  { n: 43, t: "+", code: [["    "], ["let", "kw"], [" left = item.count;"]], mk: "var(--k-important)" },
  { o: 43, n: 44, t: " ", code: [["    "], ["for", "kw"], [" ("], ["const", "kw"], [" s "], ["of", "kw"], [" "], ["this", "kw"], [".stacksOf(item.id)) {"]], mk: "var(--k-important)" },
  { n: 45, t: "+", code: [["      left = s.fill(left);"]], mk: "var(--k-important)" },
  { o: 44, n: 46, t: " ", code: [["    }"]], mk: "var(--k-important)" },
  { n: 47, t: "+", code: [["    "], ["return", "kw"], [" left; "], ["// overflow the caller must handle", "cm"]], mk: "var(--k-important)" }
];

const tail: Row[] = [
  { o: 52, n: 55, t: " ", code: [["  "], ["drainNewestFirst", "fn"], ["(id: "], ["string", "ty"], [") {"]] },
  { o: 53, t: "-", code: [["    "], ["const", "kw"], [" order = "], ["this", "kw"], [".stacksOf(id);"]] },
  { n: 56, t: "+", code: [["    "], ["const", "kw"], [" order = "], ["this", "kw"], [".stacksOf(id).reverse();"]], mk: "var(--k-question)" }
];

function Line({ r }: { r: Row }) {
  const cls = ["ln", r.t === "+" ? "add" : r.t === "-" ? "del" : "", r.mk ? "mark" : ""].join(" ");
  return (
    <div className={cls} style={r.mk ? { "--mk": r.mk } : undefined}>
      <span className="n">{r.o ?? ""}</span>
      <span className="n">{r.n ?? ""}</span>
      <span className="s">{r.t === "+" ? "+" : r.t === "-" ? "−" : ""}</span>
      <span className="c">{L(...r.code)}</span>
    </div>
  );
}

const files: { s: "A" | "M"; name: string; on?: boolean; done?: boolean; dots?: string[] }[] = [
  { s: "M", name: "inventory.ts", on: true, dots: ["var(--k-important)", "var(--k-question)"] },
  { s: "M", name: "save/migrate.ts", dots: ["var(--k-todo)"] },
  { s: "A", name: "stacking.ts", dots: ["var(--k-why)"] }
];
const changes = ["hud/slots.tsx", "items/registry.ts", "loot/drop.ts"];
const low = ["inventory.test.ts", "fixtures/items.json"];

export function ProductMock() {
  return (
    <div className="win" role="img" aria-label="The sift review UI: a ranked file list, a diff with an agent's margin note and a reviewer comment, and the walkthrough bar">
      <div className="win-top">
        <div className="dots"><i /><i /><i /></div>
        <span className="t-brand"><Mark />sift</span>
        <span className="t-repo">pocket-rpg</span>
        <span className="t-branch">main</span>
        <span className="t-source">Session · Stackable inventory items</span>
        <span className="t-live"><i />Live</span>
      </div>
      <div className="win-body">
        <aside className="side" aria-hidden="true">
          <div className="side-tabs"><b>Files 9</b><span>Notes 5</span><span>Comments 1</span></div>
          <div className="band">Start here <span>3</span></div>
          {files.map((f) => (
            <div key={f.name} className={`frow ${f.on ? "on" : ""}`}>
              <span className={`fs ${f.s}`}>{f.s}</span>
              {f.name}
              <span className="fdot">{f.dots?.map((d, i) => <i key={i} style={{ background: d }} />)}</span>
            </div>
          ))}
          <div className="band">Changes <span>3</span></div>
          {changes.map((n, i) => (
            <div key={n} className={`frow ${i < 2 ? "done" : ""}`}><span className="fs M">M</span>{n}</div>
          ))}
          <div className="band">Low signal <span>2</span></div>
          {low.map((n) => (
            <div key={n} className="frow done"><span className="fs M">M</span>{n}</div>
          ))}
          <div className="side-foot"><i /></div>
          <div className="side-foot-t">3 of 9 files viewed</div>
        </aside>
        <div className="main">
          <div className="fhead">
            <span className="fs M">M</span>
            <span className="path">src/game/<b>inventory.ts</b></span>
            <span className="tag">Important</span>
            <span className="churn">+18 −6</span>
            <span className="viewed">Viewed</span>
          </div>
          <div className="diff">
            <div className="gap">⋯ 40 unchanged lines · class Inventory</div>
            {rows.map((r, i) => <Line key={i} r={r} />)}
            <div className="ann">
              <div className="note" style={{ "--mk": "var(--k-important)" }}>
                <div className="note-h">
                  <span className="stamp">Look here</span>
                  <span className="step">Step 1</span>
                  <span className="note-t">add() now returns the overflow instead of a boolean</span>
                </div>
                <div className="note-b">
                  Callers doing <code>if (!inv.add(x))</code> now invert. None found in this repo; the HUD reads the return value in one place.
                </div>
              </div>
            </div>
            <div className="gap">⋯ 7 unchanged lines</div>
            {tail.map((r, i) => <Line key={i} r={r} />)}
            <div className="ann">
              <div className="note" style={{ "--mk": "var(--k-question)" }}>
                <div className="note-h">
                  <span className="stamp">Question</span>
                  <span className="step">Step 2</span>
                  <span className="note-t">Drain newest or oldest stack first?</span>
                </div>
                <div className="note-b">Chose newest. Say if design wants FIFO.</div>
              </div>
              <div className="thread">
                <div className="who"><b>you</b> · line 56</div>
                FIFO please, the oldest stacks should empty first.
                <div className="reply"><span className="who"><b>agent</b> · </span>Switched to oldest-first and added a test. Resolved.</div>
              </div>
            </div>
          </div>
          <div className="tour" aria-hidden="true">
            <span className="cnt">2<span>/5</span></span>
            <span className="stamp" style={{ "--mk": "var(--k-question)" }}>Question</span>
            <span className="tt">
              <b>Drain newest or oldest stack first?</b>
              <span>src/game/inventory.ts:56</span>
            </span>
            <span className="btn">Prev<kbd>←</kbd></span>
            <span className="btn pri">Next<kbd>→</kbd></span>
          </div>
        </div>
      </div>
    </div>
  );
}
