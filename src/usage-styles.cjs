/** 单页使用分析的天空蓝玻璃样式；作用域限 auralis-usage-*，明暗主题沿用宿主令牌。 */
'use strict';

const usageStyles = `
.auralis-usage-page{width:100%;min-width:0;height:100%;overflow:auto;scrollbar-width:none;box-sizing:border-box;padding:24px clamp(12px,3vw,36px) 40px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;scroll-behavior:smooth;container-type:inline-size;--auralis-usage-surface:color-mix(in srgb,var(--dsw-alias-bg-base) 52%,transparent);--auralis-usage-muted:var(--dsw-alias-label-secondary);--auralis-usage-line:var(--dsw-alias-border-l1)}
.auralis-usage-page{--auralis-usage-heat-1:#dbeafe;--auralis-usage-heat-2:#93c5fd;--auralis-usage-heat-3:#60a5fa;--auralis-usage-heat-4:#3b82f6;--auralis-usage-heat-5:#1d4ed8}
[data-ds-dark-theme] .auralis-usage-page{--auralis-usage-heat-1:#1e3a5f;--auralis-usage-heat-2:#23549b;--auralis-usage-heat-3:#2563eb;--auralis-usage-heat-4:#3b82f6;--auralis-usage-heat-5:#7cc4f5}
.auralis-usage-page::-webkit-scrollbar{display:none;width:0;height:0}
.auralis-usage-page *{box-sizing:border-box}
.auralis-usage-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:16px}
.auralis-usage-eyebrow{display:flex;align-items:center;gap:7px;margin-bottom:6px;font:10px ui-monospace,monospace;letter-spacing:.14em;color:var(--auralis-usage-muted)}
.auralis-usage-status-dot{width:6px;height:6px;border-radius:50%;background:#14b8a6;box-shadow:0 0 0 3px #14b8a620}
.auralis-usage-head h1{margin:0;font-size:25px;font-weight:650;letter-spacing:.04em}
.auralis-usage-head p,.auralis-usage-note{margin:6px 0;font-size:11px;line-height:1.7;color:var(--auralis-usage-muted)}
.auralis-usage-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.auralis-usage-seg{display:flex;flex-wrap:wrap;gap:2px;padding:4px;border:1px solid var(--auralis-usage-line);border-radius:18px;background:var(--auralis-usage-surface);backdrop-filter:blur(16px)}
.auralis-usage-seg button,.auralis-usage-btn{border:0;border-radius:14px;background:transparent;color:var(--auralis-usage-muted);font:inherit;font-size:12px;padding:6px 10px;cursor:pointer;transition:background .15s,color .15s,box-shadow .15s}
.auralis-usage-seg button:hover,.auralis-usage-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.auralis-usage-seg button[aria-pressed=true]{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-brand-primary);font-weight:650;box-shadow:inset 0 1px 0 #ffffff40,0 3px 9px #12344c0d}
.auralis-usage-btn{border:1px solid var(--auralis-usage-line);background:var(--auralis-usage-surface)}
.auralis-usage-btn:disabled{opacity:.55;cursor:default}
.auralis-usage-page :is(button,a,input,select,[tabindex]):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.auralis-usage-jumps{display:flex;flex-wrap:wrap;gap:16px;margin:0 0 22px;border-bottom:1px solid var(--auralis-usage-line);padding-bottom:10px;font-size:11px}
.auralis-usage-jumps a{color:var(--auralis-usage-muted);text-decoration:none}.auralis-usage-jumps a:hover{color:var(--dsw-alias-brand-primary)}
.auralis-usage-section{scroll-margin-top:16px;margin-bottom:22px}
.auralis-usage-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:22px 0 12px}
.auralis-usage-section-head h2{display:flex;gap:10px;align-items:center;margin:0;font-size:14px;font-weight:650}
.auralis-usage-section-head h2 span{font:10px ui-monospace,monospace;color:var(--dsw-alias-brand-primary);opacity:.8}
.auralis-usage-section-head p{margin:0;font-size:11px;color:var(--auralis-usage-muted)}
.auralis-usage-alert{margin-bottom:12px;padding:10px 14px;border-radius:8px;border:1px solid #ef444466;background:#ef44441a;font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.auralis-usage-alert summary{cursor:pointer}.auralis-usage-alert ul{max-height:140px;overflow:auto}
.auralis-usage-card{min-width:0;padding:18px;border:1px solid var(--auralis-usage-line);border-radius:14px;background:var(--auralis-usage-surface);backdrop-filter:blur(16px) saturate(140%);box-shadow:inset 0 1px 0 #ffffff26,0 5px 18px #0b304706;animation:auralis-usage-in .35s ease both}
.auralis-usage-card h2{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px;margin:0 0 12px;font-size:14px;font-weight:650}
.auralis-usage-card h2 small{font-size:11px;font-weight:400;color:var(--auralis-usage-muted)}
.auralis-usage-kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}
.auralis-usage-kpi{position:relative;overflow:hidden;padding:17px 15px 10px;background:radial-gradient(120% 150% at 0% 0%,color-mix(in srgb,var(--c) 15%,transparent),transparent 65%),linear-gradient(180deg,#ffffff0f,transparent),var(--auralis-usage-surface);transition:transform .15s,border-color .15s,box-shadow .15s}
.auralis-usage-kpi::before{content:'';position:absolute;inset:0 0 auto;height:3px;background:linear-gradient(90deg,transparent,var(--c) 16px,color-mix(in srgb,var(--c) 60%,transparent) 45%,transparent 90%)}
.auralis-usage-kpi:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--c) 38%,var(--auralis-usage-line));box-shadow:0 12px 25px #10314b14}
.auralis-usage-kpi-label{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;color:var(--auralis-usage-muted)}
.auralis-usage-kpi-icon{display:grid;place-items:center;flex:none;width:27px;height:27px;border-radius:8px;background:var(--c);color:white;box-shadow:0 4px 10px color-mix(in srgb,var(--c) 22%,transparent)}
.auralis-usage-kpi-value{margin:8px 0 4px;font-size:clamp(22px,2vw,30px);font-weight:750;line-height:1.3;letter-spacing:-.03em}
.auralis-usage-kpi-sub{min-height:30px;font-size:10px;line-height:1.5;color:var(--auralis-usage-muted)}
.auralis-usage-spark{display:block;width:100%;height:40px;margin-top:8px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 24%,transparent)}
.auralis-usage-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-bottom:14px}
.auralis-usage-wide{margin-bottom:14px}
.auralis-usage-chart-frame{width:100%;height:260px;min-width:0}
.auralis-usage-chart{display:block;width:100%;height:260px;overflow:visible}
.auralis-usage-chart text{fill:var(--auralis-usage-muted);font-family:inherit}
.auralis-usage-chart :is(path,rect,circle){transition:opacity .15s,stroke-width .15s}
.auralis-usage-chart [role=button],.auralis-usage-donut [role=button]{cursor:pointer}
.auralis-usage-axis{display:flex;justify-content:space-between;margin-top:5px;font-size:10px;color:var(--auralis-usage-muted)}
.auralis-usage-legend{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-top:12px;font-size:11px;color:var(--auralis-usage-muted)}
.auralis-usage-legend button{display:inline-flex;align-items:center;gap:5px;border:1px solid transparent;border-radius:7px;padding:5px 7px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}
.auralis-usage-legend button:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.auralis-usage-area-legend button[aria-pressed=false]{opacity:.45;text-decoration:line-through}
.auralis-usage-legend b{font-weight:650;color:var(--dsw-alias-label-primary)}
.auralis-usage-swatch{display:inline-block;flex:none;width:8px;height:8px;margin-right:5px;border-radius:3px;background:var(--c)}
.auralis-usage-empty{padding:35px 8px;text-align:center;font-size:12px;color:var(--auralis-usage-muted)}
.auralis-usage-split{display:flex;flex-wrap:wrap;align-items:center;gap:18px}
.auralis-usage-split > .auralis-usage-scroll{flex:1;min-width:220px}
.auralis-usage-donut{flex:none;width:160px;height:160px;overflow:visible}
.auralis-usage-donut text{fill:var(--dsw-alias-label-primary);text-anchor:middle}
.auralis-usage-donut :is(path,circle){transition:transform .18s,opacity .18s}
.auralis-usage-scroll{overflow:auto;max-height:420px;scrollbar-width:none}
.auralis-usage-scroll::-webkit-scrollbar{display:none;width:0;height:0}
.auralis-usage-table{width:100%;border-collapse:collapse;font-size:11px}
.auralis-usage-table th{position:sticky;top:0;z-index:1;padding:8px;text-align:left;font-weight:500;white-space:nowrap;color:var(--auralis-usage-muted);background:var(--dsw-specific-menu);backdrop-filter:blur(12px);border-bottom:1px solid var(--auralis-usage-line)}
.auralis-usage-table td{padding:8px;white-space:nowrap;border-bottom:1px solid color-mix(in srgb,var(--auralis-usage-line) 60%,transparent)}
.auralis-usage-table tbody tr:hover td:not(.auralis-usage-heat-cell){background:var(--dsw-alias-interactive-bg-hover-solid)}
.auralis-usage-table button{max-width:220px;overflow:hidden;text-overflow:ellipsis;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.auralis-usage-table .auralis-usage-num{text-align:right}
.auralis-usage-clip{display:inline-block;max-width:220px;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom}
.auralis-usage-dim{color:var(--auralis-usage-muted)}
.auralis-usage-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;background:#22c55e24;color:#15803d}
.auralis-usage-badge[data-bad]{background:#ef444424;color:#dc2626}
.auralis-usage-tag{margin-left:6px;padding:0 5px;border-radius:4px;font-size:10px;background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-brand-primary)}
[data-ds-dark-theme] .auralis-usage-badge{color:#4ade80}[data-ds-dark-theme] .auralis-usage-badge[data-bad]{color:#f87171}
.auralis-usage-rank{display:grid;gap:12px}
.auralis-usage-rank-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 10px;font-size:11px}
.auralis-usage-rank-row > span:first-child{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.auralis-usage-meter{grid-column:1/-1;height:5px;border-radius:3px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);overflow:hidden}
.auralis-usage-meter > span{display:block;height:100%;border-radius:inherit;background:var(--c,var(--dsw-alias-brand-primary))}
.auralis-usage-errors{display:grid;gap:10px;margin:0;padding:0;list-style:none;font-size:12px}
.auralis-usage-errors li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px}
.auralis-usage-errors p{grid-column:1/-1;margin:0;font-size:11px;color:var(--auralis-usage-muted);overflow-wrap:anywhere}
.auralis-usage-filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.auralis-usage-filters select,.auralis-usage-filters input{min-width:0;padding:6px 9px;border:1px solid var(--auralis-usage-line);border-radius:8px;background:var(--dsw-specific-input-major);color:inherit;font:inherit;font-size:12px}
.auralis-usage-filters input{flex:1 1 180px}
.auralis-usage-more{display:flex;justify-content:center;margin-top:12px}
.auralis-usage-heat-summary{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:12px}
.auralis-usage-heat-summary strong{font-size:24px;font-weight:750;letter-spacing:-.03em;color:var(--dsw-alias-brand-primary)}
.auralis-usage-heat-summary span{font-size:11px;color:var(--auralis-usage-muted)}
.auralis-usage-heat-scroll{overflow-x:auto;padding:6px 2px}
.auralis-usage-heat{display:grid;grid-template-rows:repeat(7,1fr);grid-template-columns:repeat(52,1fr);grid-auto-flow:column;gap:3px;min-width:300px;aspect-ratio:52/7}
.auralis-usage-heat button{padding:0;border:0;border-radius:2px;background:var(--cell);cursor:pointer;transition:transform .15s,opacity .15s}
.auralis-usage-heat button:hover,.auralis-usage-heat button:focus-visible{transform:scaleY(1.6);opacity:.85}
.auralis-usage-heat-key{display:flex;align-items:center;justify-content:flex-end;gap:4px;margin-top:8px;font-size:10px;color:var(--auralis-usage-muted)}
.auralis-usage-heat-key i{display:block;width:9px;height:9px;border-radius:2px;background:var(--cell)}
.auralis-usage-heat-detail{min-height:34px;margin:8px 0 0;font-size:10px;color:var(--auralis-usage-muted);line-height:1.6}
.auralis-usage-footer{margin-top:14px;font-size:10px;color:var(--auralis-usage-muted);line-height:1.7}
.auralis-usage-model-legend,.auralis-usage-token-legend{flex:1;display:grid;align-content:center;gap:8px;min-width:160px;margin-top:0}
.auralis-usage-model-legend button{display:flex;justify-content:space-between;flex-wrap:wrap;min-width:0;overflow-wrap:anywhere}
.auralis-usage-token-legend > div{font-size:11px;line-height:1.6}
.auralis-usage-token-part{width:100%;min-width:0}.auralis-usage-token-part-label{display:flex;align-items:center;flex-wrap:wrap;gap:4px}
.auralis-usage-token-progress{overflow:hidden}
.auralis-usage-area-legend button{flex-wrap:wrap;overflow-wrap:anywhere;max-width:100%}
.auralis-usage-linked-row[data-active=true] td,.auralis-usage-legend-button[data-active=true]{background:var(--dsw-alias-interactive-bg-hover-solid)}
.auralis-usage-legend .auralis-usage-swatch-line{width:16px;height:0;border-top:2px dashed var(--c);border-radius:0;background:transparent;vertical-align:middle}
.auralis-usage-ribbon-rows{min-width:0}.auralis-usage-ribbon-row{min-width:0;border-bottom:1px solid var(--auralis-usage-line);padding-left:10px}
.auralis-usage-ribbon-row .auralis-usage-clip{display:block;max-width:100%;font-size:12px;font-weight:600}
.auralis-usage-ribbon-row .auralis-usage-dim{font-size:10px;line-height:1.5;overflow-wrap:anywhere}
.auralis-usage-speed{max-height:330px;margin-top:10px}.auralis-usage-speed-row,.auralis-usage-speed-scale{font-size:11px;min-width:340px}
.auralis-usage-speed-row{border-bottom:1px solid var(--auralis-usage-line)}.auralis-usage-speed-row > *{min-width:0}
.auralis-usage-speed-scale{padding:8px 0}.auralis-usage-speed .auralis-usage-num{text-align:right;font-size:10px}
.auralis-usage-speed-row .auralis-usage-dim{font-size:10px;margin-top:3px}
.auralis-usage-matrix{border-collapse:separate;border-spacing:4px;min-width:520px}
.auralis-usage-matrix tbody th{position:static;background:transparent;backdrop-filter:none}
.auralis-usage-matrix td{border:0;border-radius:5px;min-width:75px}
.auralis-usage-matrix th{font-size:11px}.auralis-usage-matrix .auralis-usage-heat-cell{font-weight:600}
.auralis-usage-matrix thead th:not(:first-child):not(:last-child){max-width:180px;white-space:normal;overflow-wrap:anywhere}
.auralis-usage-chart-tooltip rect{fill:var(--dsw-alias-bg-base);stroke:var(--auralis-usage-line)}
.auralis-usage-chart [data-p95-axis] rect{fill:var(--dsw-alias-bg-base)}
@keyframes auralis-usage-in{from{opacity:0;transform:translateY(5px)}}
@container(max-width:1100px){.auralis-usage-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
@container(max-width:900px){.auralis-usage-grid{grid-template-columns:minmax(0,1fr)}.auralis-usage-section-head{flex-wrap:wrap}.auralis-usage-card{padding:14px}}
@container(max-width:420px){.auralis-usage-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.auralis-usage-kpi-value{font-size:23px}.auralis-usage-seg button{padding:5px 8px}.auralis-usage-clip{max-width:150px}}
@media(prefers-reduced-motion:reduce){.auralis-usage-page{scroll-behavior:auto}.auralis-usage-card{animation:none}.auralis-usage-page *{transition:none}.auralis-usage-kpi:hover,.auralis-usage-heat button:hover{transform:none}}
@media(prefers-reduced-transparency:reduce){.auralis-usage-page{--auralis-usage-surface:var(--dsw-alias-bg-base)}.auralis-usage-card,.auralis-usage-seg,.auralis-usage-table th{backdrop-filter:none}.auralis-usage-table th{background:var(--dsw-alias-bg-base)}}
`;

module.exports = { usageStyles };
