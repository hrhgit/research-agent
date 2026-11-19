/** Styles for the research status board. It sits in a narrow side column first and widens into two columns when there is room. */
export const boardStyles = `
.rb{--rb-ok:#2f9e5b;--rb-bad:#d2553f;--rb-warn:#c98a1b;--rb-run:#3d7eea;--rb-rule:color-mix(in srgb,currentColor 16%,transparent);--rb-soft:color-mix(in srgb,currentColor 6%,transparent);--rb-dim:color-mix(in srgb,currentColor 60%,transparent);height:100%;overflow:auto;padding:16px 16px 28px;box-sizing:border-box;font-size:13px;line-height:1.55;container-type:inline-size}
.rb--embedded{height:auto;overflow:visible;padding:0}
.rb *,.rb *::before,.rb *::after{box-sizing:border-box}.rb h2,.rb h3,.rb p,.rb ul,.rb ol,.rb dl,.rb dd{margin:0;padding:0}.rb ul,.rb ol{list-style:none}
.rb-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.rb-head h2{font-size:15px;font-weight:600}
.rb-live{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--rb-dim);font-variant-numeric:tabular-nums}
.rb-live i{width:7px;height:7px;border-radius:50%;background:var(--rb-ok);animation:rb-blink 1s ease-out}.rb-live--off i{background:var(--rb-bad);animation:none}
.rb-error{border-left:3px solid var(--rb-bad);padding:6px 10px;margin-top:10px!important}
.rb-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:12px}
.rb-tile{background:var(--rb-soft);border-radius:8px;padding:8px 10px;min-width:0}.rb-tile b{display:block;font-size:19px;font-weight:550;line-height:1.25;font-variant-numeric:tabular-nums}.rb-tile span{display:block;font-size:11px;color:var(--rb-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rb-tile--run b{color:var(--rb-run)}.rb-tile--ok b{color:var(--rb-ok)}.rb-tile--bad b{color:var(--rb-bad)}
.rb-section{margin-top:24px}.rb-section>h3{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:12px;font-weight:600;letter-spacing:.02em;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--rb-rule)}.rb-section>h3 span{font-weight:400;font-size:11.5px;color:var(--rb-dim)}
.rb-empty{color:var(--rb-dim);font-size:12.5px}
.rb-chip{font-size:11px;font-weight:400;padding:0 7px;border-radius:9px;background:var(--rb-soft);color:var(--rb-dim);white-space:nowrap}
.rb-chip--running,.rb-chip--active,.rb-chip--incubating{color:var(--rb-run);background:color-mix(in srgb,var(--rb-run) 13%,transparent)}.rb-chip--waiting,.rb-chip--undecided,.rb-chip--paused,.rb-chip--blocked{color:var(--rb-warn);background:color-mix(in srgb,var(--rb-warn) 14%,transparent)}.rb-chip--adopted,.rb-chip--graduated{color:var(--rb-ok);background:color-mix(in srgb,var(--rb-ok) 13%,transparent)}.rb-chip--abandoned,.rb-chip--stopped{color:var(--rb-bad);background:color-mix(in srgb,var(--rb-bad) 12%,transparent)}
.rb-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;color:var(--rb-dim);cursor:pointer;margin-top:2px!important}.rb-clamp[aria-expanded=true]{display:block}.rb-clamp:focus-visible{outline:2px solid currentColor;outline-offset:2px}

.rb-hub{position:relative;display:flex;align-items:baseline;gap:8px;padding-left:26px;min-height:22px}.rb-hub b{font-weight:600}.rb-hub span{font-size:11.5px;color:var(--rb-dim)}
.rb-hub::before{content:"";position:absolute;left:1px;top:3px;width:16px;height:16px;border-radius:50%;border:2px solid currentColor}.rb-hub::after{content:"";position:absolute;left:7px;top:9px;width:4px;height:4px;border-radius:50%;background:currentColor}
.rb-request{position:relative;margin-left:8.25px;padding:10px 0 2px 20px;border-left:1.5px solid var(--rb-rule)}.rb-request:last-child{border-left-color:transparent}
.rb-request__head{display:flex;align-items:baseline;gap:8px}.rb-request__head strong{font-weight:550;overflow-wrap:anywhere}
.rb-elbow{position:absolute;left:-1.5px;top:0;fill:none;stroke:var(--rb-rule);stroke-width:1.5}
.rb-agent{position:relative;margin-left:5px;padding:9px 0 3px 24px;border-left:1.5px solid var(--rb-rule);animation:rb-enter .35s ease-out both}.rb-agent:last-child{border-left-color:transparent}
.rb-node{position:absolute;left:11px;top:15px;width:9px;height:9px;border-radius:50%;border:1.5px solid var(--rb-dim)}
.rb-agent--waiting .rb-node{border-color:var(--rb-warn)}
.rb-agent--running .rb-node{background:var(--rb-run);border-color:var(--rb-run)}.rb-agent--running .rb-node::after{content:"";position:absolute;inset:-5px;border-radius:50%;border:1.5px solid var(--rb-run);animation:rb-pulse 1.6s ease-out infinite}
.rb-agent--running>.rb-elbow{stroke:var(--rb-run);stroke-dasharray:3 3;animation:rb-flow .7s linear infinite}
.rb-agent__head{display:flex;align-items:baseline;gap:6px}.rb-agent__head b{font-weight:600}.rb-agent__head time{margin-left:auto;font-size:11px;color:var(--rb-dim);font-variant-numeric:tabular-nums;white-space:nowrap}
.rb-agent__what{overflow-wrap:anywhere;margin-top:2px!important}
.rb-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}.rb-tag{font-size:11px;border:1px solid var(--rb-rule);border-radius:4px;padding:0 5px;color:var(--rb-dim);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rb-tag--run{border-color:color-mix(in srgb,var(--rb-run) 50%,transparent);color:var(--rb-run)}
.rb-more{margin-top:10px;font-size:12px;color:var(--rb-dim)}.rb-more summary{cursor:pointer}.rb-more li{display:flex;gap:8px;align-items:baseline;padding-top:5px}.rb-more li span:first-child{flex:1;min-width:0;overflow-wrap:anywhere}

.rb-card{border:1px solid var(--rb-rule);border-radius:10px;padding:12px;margin-bottom:10px;animation:rb-enter .35s ease-out both}
.rb-card__head{display:flex;align-items:baseline;gap:8px}.rb-card__head strong{flex:1;min-width:0;font-weight:600;overflow-wrap:anywhere}.rb-card__sub{font-size:11.5px;color:var(--rb-dim)}
.rb-chart{display:block;width:100%;height:auto;margin:8px 0 6px;overflow:visible}.rb-chart text{fill:currentColor;font-size:9.5px;font-variant-numeric:tabular-nums}
.rb-chart__grad{stroke:var(--rb-ok);stroke-width:1;stroke-dasharray:4 3}.rb-chart__zone{fill:var(--rb-ok);opacity:.08}.rb-chart__axis{stroke:var(--rb-rule);stroke-width:1}
.rb-chart__path{fill:none;stroke:var(--rb-run);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;animation:rb-draw .9s ease-out both}
.rb-chart__dot{fill:var(--rb-run)}.rb-chart__slot{fill:none;stroke:var(--rb-rule);stroke-width:1.2}.rb-chart__miss{stroke:var(--rb-bad);stroke-width:1.5;stroke-linecap:round}
.rb-chart__ping{fill:none;stroke:var(--rb-run);stroke-width:1.5;transform-box:fill-box;transform-origin:center;animation:rb-pulse 1.6s ease-out infinite}
.rb-gap{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.rb-gap b{font-size:20px;font-weight:550;font-variant-numeric:tabular-nums;line-height:1.2}.rb-gap span{font-size:11.5px;color:var(--rb-dim)}
.rb-meters{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px}.rb-meter{font-size:11px;color:var(--rb-dim)}.rb-meter div{display:flex;justify-content:space-between;font-variant-numeric:tabular-nums}
.rb-meter i{display:block;height:4px;border-radius:2px;background:var(--rb-soft);overflow:hidden;margin-top:3px}.rb-meter i u{display:block;height:100%;border-radius:2px;background:var(--rb-dim);transition:width .5s ease}.rb-meter--tight i u{background:var(--rb-warn)}
.rb-facts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;margin-top:10px!important;font-size:12.5px}.rb-facts dt{color:var(--rb-dim);white-space:nowrap}.rb-facts dd{overflow-wrap:anywhere}

.rb-filters{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.rb .rb-filter{font:inherit;font-size:11.5px;color:inherit;background:transparent;border:1px solid var(--rb-rule);border-radius:12px;padding:1px 9px;cursor:pointer}.rb .rb-filter[aria-pressed=true]{background:var(--rb-soft);border-color:currentColor;font-weight:600}.rb-filter:focus-visible,.rb-route summary:focus-visible,.rb-showall:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.rb-route{margin-bottom:16px}.rb-route>summary{cursor:pointer;list-style:none}.rb-route>summary::-webkit-details-marker{display:none}
.rb-route__title{display:flex;align-items:baseline;gap:8px}.rb-route__title strong{flex:1;min-width:0;font-weight:600;overflow-wrap:anywhere}.rb-route__title span{font-size:11px;color:var(--rb-dim);white-space:nowrap}
.rb-stack{display:flex;height:5px;border-radius:3px;overflow:hidden;margin:6px 0 4px;background:var(--rb-soft);gap:1px}.rb-stack i{min-width:3px;transition:flex-grow .5s ease}
.rb-legend{display:flex;flex-wrap:wrap;gap:1px 10px;font-size:11px;color:var(--rb-dim)}.rb-legend span::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;background:var(--rb-c)}
.rb-c--active{--rb-c:var(--rb-run)}.rb-c--adopted{--rb-c:var(--rb-ok)}.rb-c--undecided{--rb-c:var(--rb-warn)}.rb-c--pending{--rb-c:color-mix(in srgb,currentColor 35%,transparent)}.rb-c--abandoned{--rb-c:var(--rb-bad)}
.rb-stack i{background:var(--rb-c)}
.rb-lines{position:relative;margin-top:8px!important}.rb-lines::before{content:"";position:absolute;left:8.25px;top:0;bottom:0;width:1.5px;background:var(--rb-rule)}
.rb-line{position:relative;padding:4px 0 8px 34px;animation:rb-enter .35s ease-out both}
.rb-glyph{position:absolute;left:0;top:3px;fill:none;stroke-width:1.5;stroke-linecap:round;stroke:var(--rb-c);overflow:visible}.rb-glyph .rb-fill{fill:var(--rb-c);stroke:none}.rb-glyph .rb-ping{transform-box:fill-box;transform-origin:center;animation:rb-pulse 1.6s ease-out infinite}
.rb-line__head{display:flex;align-items:baseline;gap:8px}.rb-line__head strong{flex:1;min-width:0;font-weight:500;overflow-wrap:anywhere}.rb-line__head span{font-size:11px;white-space:nowrap;color:var(--rb-c)}
.rb-line--abandoned .rb-line__head strong,.rb-line--pending .rb-line__head strong{color:color-mix(in srgb,currentColor 78%,transparent)}
.rb-line__meta{font-size:11px;color:var(--rb-dim);margin-top:2px!important}
.rb .rb-showall{font:inherit;font-size:12px;color:var(--rb-dim);background:transparent;border:0;padding:2px 0 0 34px;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
@container (min-width:820px){.rb-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:0 40px;align-items:start}.rb-tiles{max-width:560px}}
@keyframes rb-pulse{0%{transform:scale(.55);opacity:.9}100%{transform:scale(1.5);opacity:0}}
@keyframes rb-flow{to{stroke-dashoffset:-6}}
@keyframes rb-enter{from{opacity:0;transform:translateY(4px)}}
@keyframes rb-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes rb-blink{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--rb-ok) 55%,transparent)}100%{box-shadow:0 0 0 7px transparent}}
@media (prefers-reduced-motion:reduce){.rb *,.rb *::before,.rb *::after{animation:none!important;transition:none!important}}
`
