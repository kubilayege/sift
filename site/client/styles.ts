// Raw CSS for the page. Palette, type and note inks match the sift review UI itself.
export const css = `
:root {
  --ink-0: #0b1017;
  --ink-1: #10161f;
  --ink-2: #161e2a;
  --ink-3: #1e2836;
  --ink-4: #2a3649;
  --rule: #222c3c;
  --text: #dde4ef;
  --text-2: #aab5c8;
  --muted: #7a879d;
  --faint: #4f5b70;
  --add: #5fd596;
  --add-bg: rgba(79, 201, 136, 0.09);
  --del: #f27e7e;
  --del-bg: rgba(242, 104, 104, 0.09);
  --k-important: #f2c14e;
  --k-risk: #ff7a6b;
  --k-question: #d29bff;
  --k-todo: #f7a25b;
  --k-why: #8ea8ff;
  --k-verify: #4fc6dd;
  --k-info: #93a1b8;
  --display: 'Bricolage Grotesque', 'Instrument Sans', system-ui, sans-serif;
  --ui: 'Instrument Sans', system-ui, -apple-system, sans-serif;
  --code: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
}
* { box-sizing: border-box; }
html { background: var(--ink-0); scroll-behavior: smooth; }
body { margin: 0; background: var(--ink-0); color: var(--text); font-family: var(--ui); font-size: 16px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
a { color: inherit; }
code, kbd, pre { font-family: var(--code); }
::selection { background: color-mix(in srgb, var(--k-important) 35%, transparent); }

.page { overflow-x: clip; }
.wrap { width: min(1120px, calc(100% - 48px)); margin: 0 auto; }

/* ---- nav --------------------------------------------------------------------------- */
.nav { position: sticky; top: 0; z-index: 20; backdrop-filter: blur(12px); background: color-mix(in srgb, var(--ink-0) 82%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--rule) 60%, transparent); }
.nav .wrap { display: flex; align-items: center; gap: 28px; height: 56px; }
.brand { display: flex; align-items: center; gap: 9px; font-family: var(--display); font-weight: 700; font-size: 19px; letter-spacing: -0.02em; text-decoration: none; }
.nav-links { display: flex; gap: 22px; margin-left: auto; font-size: 14px; color: var(--text-2); }
.nav-links a { text-decoration: none; }
.nav-links a:hover { color: var(--text); }
.nav-ver { font-family: var(--code); font-size: 12px; color: var(--muted); border: 1px solid var(--rule); border-radius: 99px; padding: 2px 9px; }

/* ---- hero -------------------------------------------------------------------------- */
.hero { position: relative; padding: 92px 0 40px; }
.hero::before { content: ''; position: absolute; inset: -200px -20% auto; height: 760px; background:
  radial-gradient(520px 300px at 18% 30%, color-mix(in srgb, var(--k-important) 12%, transparent), transparent 70%),
  radial-gradient(560px 340px at 82% 10%, color-mix(in srgb, var(--k-why) 13%, transparent), transparent 70%);
  pointer-events: none; }
.hero .wrap { position: relative; }
.eyebrow { display: inline-flex; align-items: center; gap: 10px; font-family: var(--code); font-size: 12.5px; color: var(--text-2); letter-spacing: 0.02em; }
.eyebrow i { width: 7px; height: 7px; border-radius: 50%; background: var(--add); box-shadow: 0 0 0 4px color-mix(in srgb, var(--add) 18%, transparent); }
h1 { font-family: var(--display); font-weight: 700; font-size: clamp(44px, 7.4vw, 92px); line-height: 1; letter-spacing: -0.03em; margin: 22px 0 0; max-width: 12ch; }
h1 em { font-style: normal; background: linear-gradient(transparent 62%, color-mix(in srgb, var(--k-important) 38%, transparent) 62%, color-mix(in srgb, var(--k-important) 38%, transparent) 92%, transparent 92%); }
.lede { font-size: clamp(17px, 1.8vw, 20px); color: var(--text-2); max-width: 60ch; margin: 26px 0 0; line-height: 1.6; }
.lede b { color: var(--text); font-weight: 600; }

.install { margin-top: 36px; max-width: 640px; }
.cmd { display: flex; align-items: center; gap: 12px; background: var(--ink-1); border: 1px solid var(--ink-4); border-radius: 10px; padding: 6px 6px 6px 18px; box-shadow: 0 24px 60px -30px rgba(0,0,0,0.8); }
.cmd code { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; font-size: 14px; color: var(--text); scrollbar-width: none; padding: 8px 0; }
.cmd code::-webkit-scrollbar { display: none; }
.cmd .p { color: var(--faint); user-select: none; margin-right: 10px; }
.copy { flex: none; border: 1px solid var(--ink-4); background: var(--ink-2); color: var(--text); font: 500 13px var(--ui); border-radius: 7px; padding: 8px 13px; cursor: pointer; transition: background .15s, border-color .15s; }
.copy:hover { background: var(--ink-3); }
.copy.ok { border-color: color-mix(in srgb, var(--add) 55%, var(--ink-4)); color: var(--add); }
.install-meta { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 14px; font-size: 13.5px; color: var(--muted); }
.install-meta a { color: var(--text-2); text-underline-offset: 3px; }

/* ---- product mock ------------------------------------------------------------------ */
.stage { padding: 56px 0 24px; }
.win { position: relative; border: 1px solid var(--ink-4); border-radius: 14px; background: var(--ink-0); overflow: hidden; box-shadow: 0 60px 120px -40px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,255,255,0.02) inset; font-size: 13px; }
.win-top { display: flex; align-items: center; gap: 14px; height: 44px; padding: 0 16px; border-bottom: 1px solid var(--rule); background: var(--ink-1); }
.dots { display: flex; gap: 7px; }
.dots i { width: 11px; height: 11px; border-radius: 50%; background: var(--ink-4); }
.win-top .t-brand { display: flex; align-items: center; gap: 7px; font-weight: 700; font-family: var(--display); font-size: 14px; }
.win-top .t-repo { color: var(--text-2); font-weight: 600; }
.win-top .t-branch { font-family: var(--code); color: var(--muted); font-size: 11.5px; }
.win-top .t-source { margin-left: 6px; border: 1px solid var(--ink-4); border-radius: 6px; padding: 4px 10px; color: var(--text-2); background: var(--ink-0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px; }
.win-top .t-live { margin-left: auto; display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
.win-top .t-live i { width: 7px; height: 7px; border-radius: 50%; background: var(--add); }
.win-body { display: grid; grid-template-columns: 236px 1fr; min-height: 480px; }
.side { border-right: 1px solid var(--rule); background: var(--ink-1); padding: 14px 10px; }
.side-tabs { display: flex; gap: 14px; padding: 0 6px 12px; font-size: 12.5px; color: var(--muted); }
.side-tabs b { color: var(--text); font-weight: 600; }
.band { font-size: 10.5px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--muted); padding: 12px 6px 6px; display: flex; gap: 8px; }
.band span { color: var(--faint); }
.frow { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; color: var(--text-2); font-size: 12.5px; white-space: nowrap; }
.frow.on { background: var(--ink-3); color: var(--text); box-shadow: inset 2px 0 0 var(--k-why); }
.frow.done { color: var(--faint); text-decoration: line-through; text-decoration-color: var(--ink-4); }
.fs { width: 16px; height: 16px; flex: none; border-radius: 4px; display: grid; place-items: center; font: 600 9.5px var(--code); }
.fs.A { color: var(--add); background: var(--add-bg); }
.fs.M { color: var(--k-important); background: color-mix(in srgb, var(--k-important) 11%, transparent); }
.fdot { margin-left: auto; display: flex; gap: 3px; }
.fdot i { width: 6px; height: 6px; border-radius: 50%; }
.side-foot { margin: 18px 6px 0; height: 4px; border-radius: 4px; background: var(--ink-3); overflow: hidden; }
.side-foot i { display: block; height: 100%; width: 38%; background: var(--add); }
.side-foot-t { margin: 7px 6px 0; font-size: 11px; color: var(--muted); }

.main { padding: 18px 22px 76px; position: relative; min-width: 0; }
.fhead { display: flex; align-items: center; gap: 10px; border: 1px solid color-mix(in srgb, var(--k-important) 28%, var(--rule)); border-radius: 8px 8px 0 0; background: var(--ink-1); padding: 9px 12px; box-shadow: inset 3px 0 0 color-mix(in srgb, var(--k-important) 70%, transparent); }
.fhead .path { font-family: var(--code); font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fhead .path b { color: var(--text); font-weight: 500; }
.fhead .tag { margin-left: auto; font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--k-important); }
.fhead .churn { font-family: var(--code); font-size: 11.5px; color: var(--add); }
.fhead .viewed { font-size: 11.5px; color: var(--muted); border: 1px solid var(--ink-4); border-radius: 6px; padding: 3px 8px; }
.diff { border: 1px solid var(--rule); border-top: 0; border-radius: 0 0 8px 8px; overflow: hidden; font-family: var(--code); font-size: 12px; }
.ln { display: grid; grid-template-columns: 38px 38px 18px 1fr; line-height: 21px; white-space: pre; position: relative; }
.ln .n { color: var(--faint); text-align: right; padding-right: 8px; font-size: 11px; }
.ln .s { color: var(--faint); text-align: center; }
.ln .c { overflow: hidden; text-overflow: ellipsis; padding-right: 12px; }
.ln.add { background: var(--add-bg); }
.ln.add .s { color: var(--add); }
.ln.del { background: var(--del-bg); }
.ln.del .s { color: var(--del); }
.ln.mark::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--mk); }
.gap { font-size: 11px; color: var(--faint); padding: 5px 12px; background: var(--ink-1); border-block: 1px solid var(--rule); }
.kw { color: #c792ea; } .fn { color: #82aaff; } .ty { color: #ffcb6b; } .st { color: #c3e88d; } .cm { color: var(--faint); font-style: italic; } .nu { color: #f78c6c; }
.ann { padding: 10px 14px 12px 44px; background: var(--ink-0); border-block: 1px solid var(--rule); font-family: var(--ui); white-space: normal; }
.note { --mk: var(--k-risk); border-radius: 7px; background: color-mix(in srgb, var(--mk) 6%, var(--ink-1)); border: 1px solid color-mix(in srgb, var(--mk) 24%, var(--rule)); box-shadow: inset 3px 0 0 var(--mk); padding: 10px 14px 11px 16px; }
.note + .note { margin-top: 8px; }
.note-h { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.stamp { font: 700 10px var(--code); letter-spacing: 0.06em; text-transform: uppercase; color: var(--mk); border: 1px solid color-mix(in srgb, var(--mk) 45%, transparent); border-radius: 4px; padding: 1px 6px; }
.step { font: 500 11px var(--code); color: var(--muted); }
.note-t { font-weight: 600; font-size: 13.5px; color: var(--text); }
.note-b { margin-top: 5px; color: var(--text-2); font-size: 13px; line-height: 1.55; }
.note-b code { font-size: 11.5px; background: var(--ink-3); border-radius: 4px; padding: 1px 5px; }
.thread { margin-top: 8px; border: 1px solid var(--ink-4); border-radius: 7px; background: var(--ink-2); padding: 9px 12px; font-size: 13px; }
.thread .who { font-size: 11.5px; color: var(--muted); margin-bottom: 3px; }
.thread .who b { color: var(--text); font-weight: 600; }
.thread .reply { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--ink-4); color: var(--text-2); }
.tour { position: absolute; left: 22px; right: 22px; bottom: 16px; display: flex; align-items: center; gap: 12px; padding: 9px 10px 9px 14px; border-radius: 10px; background: color-mix(in srgb, var(--ink-2) 92%, transparent); border: 1px solid var(--ink-4); backdrop-filter: blur(10px); box-shadow: 0 20px 40px -18px rgba(0,0,0,0.9); }
.tour .cnt { font: 700 15px var(--display); }
.tour .cnt span { color: var(--muted); font-weight: 500; font-size: 12px; }
.tour .tt { min-width: 0; flex: 1; display: flex; flex-direction: column; line-height: 1.3; }
.tour .tt b { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tour .tt span { font: 11px var(--code); color: var(--muted); }
.btn { font: 500 12.5px var(--ui); border-radius: 7px; padding: 6px 12px; border: 1px solid var(--ink-4); color: var(--text-2); background: transparent; white-space: nowrap; }
.btn.pri { background: var(--text); color: var(--ink-0); border-color: var(--text); font-weight: 600; }
.btn kbd { font-size: 10.5px; opacity: 0.6; margin-left: 6px; }

/* ---- sections ---------------------------------------------------------------------- */
section { padding: 96px 0 0; }
.kicker { font: 600 12px var(--code); letter-spacing: 0.08em; text-transform: uppercase; color: var(--k-important); }
h2 { font-family: var(--display); font-weight: 700; font-size: clamp(32px, 4.2vw, 50px); line-height: 1.06; letter-spacing: -0.024em; margin: 14px 0 0; max-width: 20ch; }
.sub { color: var(--text-2); max-width: 62ch; margin: 18px 0 0; font-size: 17px; }

/* the loop */
.loop { margin-top: 44px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; border: 1px solid var(--rule); border-radius: 14px; overflow: hidden; background: var(--ink-1); }
.loop > div { padding: 22px 22px 24px; border-right: 1px solid var(--rule); position: relative; }
.loop > div:last-child { border-right: 0; }
.who-tag { display: inline-block; font: 600 11px var(--code); letter-spacing: 0.05em; text-transform: uppercase; padding: 2px 8px; border-radius: 99px; }
.who-tag.agent { color: var(--k-why); background: color-mix(in srgb, var(--k-why) 12%, transparent); }
.who-tag.you { color: var(--k-important); background: color-mix(in srgb, var(--k-important) 12%, transparent); }
.loop .num { position: absolute; top: 18px; right: 20px; font: 700 34px var(--display); color: var(--ink-4); line-height: 1; }
.loop pre { margin: 16px 0 0; font-size: 12.5px; color: var(--text); white-space: pre-wrap; word-break: break-word; }
.loop pre .d { color: var(--faint); }
.loop p { margin: 12px 0 0; color: var(--text-2); font-size: 14px; line-height: 1.55; }

/* features */
.grid { margin-top: 44px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.card { border: 1px solid var(--rule); background: var(--ink-1); border-radius: 12px; padding: 22px 22px 24px; }
.card h3 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
.card p { margin: 9px 0 0; color: var(--text-2); font-size: 14.5px; line-height: 1.6; }
.card code { font-size: 12.5px; color: var(--text); background: var(--ink-3); padding: 1px 6px; border-radius: 4px; }
.card.wide { grid-column: span 2; }
.inks { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 16px; }
.inks span { --mk: var(--k-info); font: 600 11px var(--code); letter-spacing: 0.04em; text-transform: uppercase; color: var(--mk); border: 1px solid color-mix(in srgb, var(--mk) 40%, transparent); background: color-mix(in srgb, var(--mk) 8%, transparent); border-radius: 5px; padding: 3px 8px; }
.bands { display: grid; gap: 6px; margin-top: 16px; }
.bands div { display: flex; justify-content: space-between; font-size: 13px; padding: 7px 10px; border-radius: 7px; background: var(--ink-2); color: var(--text-2); }
.bands div b { font-weight: 600; color: var(--text); }
.bands div span { font: 12px var(--code); color: var(--muted); }

/* speed */
.speed { margin-top: 44px; display: grid; grid-template-columns: 1.05fr 1fr; gap: 16px 32px; align-items: start; }
.bench { border: 1px solid var(--rule); background: var(--ink-1); border-radius: 12px; padding: 24px; }
.bench-h { font-size: 13px; color: var(--muted); }
.bench-h b { color: var(--text); font-weight: 600; }
.bar { margin-top: 20px; }
.bar-l { display: flex; justify-content: space-between; font-size: 13.5px; }
.bar-l code { font-size: 12.5px; }
.bar-l em { font-style: normal; color: var(--muted); margin-left: 6px; }
.panel a { text-underline-offset: 3px; }
.bar-l span { font: 600 13px var(--code); }
.bar-t { margin-top: 7px; height: 10px; border-radius: 6px; background: var(--ink-3); overflow: hidden; }
.bar-t i { display: block; height: 100%; border-radius: 6px; }
.how { display: grid; gap: 12px; }
.how div { border-left: 2px solid var(--ink-4); padding: 2px 0 2px 16px; }
.how b { font-weight: 600; }
.how p { margin: 3px 0 0; color: var(--text-2); font-size: 14px; }

/* keyboard */
.keys { margin-top: 40px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 28px; }
.key { display: flex; align-items: baseline; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--rule); font-size: 14.5px; color: var(--text-2); }
.key .k { flex: none; min-width: 74px; display: flex; gap: 5px; }
kbd { font-size: 12px; color: var(--text); background: var(--ink-2); border: 1px solid var(--ink-4); border-bottom-width: 2px; border-radius: 5px; padding: 1px 7px; }

/* install */
.inst + .inst { margin-top: 16px; }
.inst { margin-top: 44px; display: grid; grid-template-columns: 1.15fr 1fr; gap: 16px; align-items: start; }
.panel { border: 1px solid var(--rule); background: var(--ink-1); border-radius: 12px; padding: 24px; }
.panel h3 { margin: 0 0 4px; font-size: 17px; font-weight: 600; }
.panel > p { margin: 6px 0 0; color: var(--text-2); font-size: 14.5px; }
.panel ul { margin: 14px 0 0; padding-left: 18px; color: var(--text-2); font-size: 14px; }
.panel li { margin: 5px 0; }
.panel li code, .panel p code { font-size: 12.5px; color: var(--text); background: var(--ink-3); padding: 1px 6px; border-radius: 4px; }
.panel .cmd { margin-top: 16px; box-shadow: none; }
.dl { margin-top: 16px; display: grid; gap: 8px; }
.dl a { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; align-items: center; text-decoration: none; padding: 12px 14px; border: 1px solid var(--ink-4); border-radius: 9px; background: var(--ink-2); transition: border-color .15s, background .15s; }
.dl a:hover { border-color: var(--muted); background: var(--ink-3); }
.dl a.rec { border-color: color-mix(in srgb, var(--k-important) 50%, var(--ink-4)); }
.dl .pl { font-weight: 600; font-size: 14.5px; }
.dl .pl span { color: var(--muted); font-weight: 400; margin-left: 6px; }
.dl .meta { grid-column: 1; font: 11px var(--code); color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dl .arrow { grid-row: span 2; grid-column: 2; font-size: 12.5px; color: var(--text-2); }
.dl .rec-tag { font: 600 10px var(--code); letter-spacing: 0.05em; text-transform: uppercase; color: var(--k-important); margin-left: 8px; }
.steps { margin: 14px 0 0; padding: 0; list-style: none; counter-reset: s; }
.steps li { counter-increment: s; position: relative; padding-left: 30px; margin: 10px 0; }
.steps li::before { content: counter(s); position: absolute; left: 0; top: 1px; width: 20px; height: 20px; border-radius: 50%; background: var(--ink-3); font: 600 11px var(--code); display: grid; place-items: center; color: var(--text-2); }
pre.block { margin: 8px 0 0; background: var(--ink-0); border: 1px solid var(--rule); border-radius: 8px; padding: 11px 14px; font-size: 12.5px; overflow-x: auto; color: var(--text); }
pre.block .c { color: var(--faint); }
.agents { margin-top: 16px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }

footer { margin-top: 110px; border-top: 1px solid var(--rule); padding: 28px 0 44px; color: var(--muted); font-size: 13.5px; }
footer .wrap { display: flex; flex-wrap: wrap; gap: 12px 28px; align-items: center; }
footer .r { margin-left: auto; }

@media (max-width: 960px) {
  .loop { grid-template-columns: 1fr 1fr; }
  .loop > div:nth-child(2) { border-right: 0; }
  .loop > div:nth-child(-n+2) { border-bottom: 1px solid var(--rule); }
  .grid, .agents { grid-template-columns: 1fr 1fr; }
  .speed, .inst { grid-template-columns: 1fr; }
  .keys { grid-template-columns: 1fr 1fr; }
  .win-body { grid-template-columns: 1fr; }
  .side { display: none; }
}
@media (max-width: 640px) {
  .wrap { width: calc(100% - 32px); }
  .nav-links a:not(.keep) { display: none; }
  .hero { padding-top: 60px; }
  .loop, .grid, .agents, .keys { grid-template-columns: 1fr; }
  .loop > div { border-right: 0; border-bottom: 1px solid var(--rule); }
  .card.wide { grid-column: auto; }
  .win-top .t-source, .win-top .t-branch { display: none; }
  .fhead .viewed, .fhead .churn { display: none; }
  .main { padding: 14px 12px 84px; }
  .ln { grid-template-columns: 30px 30px 14px 1fr; }
  .ann { padding-left: 14px; }
  .tour .btn:not(.pri) { display: none; }
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
`;
