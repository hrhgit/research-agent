export const modelStyles = `
.research-models{max-width:1120px;color:var(--dsw-alias-label-primary)}
.research-models__intro{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:24px}.research-models__intro button{flex-shrink:0}
.research-models__hint{color:var(--dsw-alias-label-secondary);max-width:72ch}
.research-models__rows{display:grid;gap:20px}
.research-models__row{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px 16px 16px;margin:0;min-width:0}
.research-models__row legend{font-size:15px;font-weight:600;padding:0 6px}
.research-models__fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr) minmax(0,1fr);gap:16px}
.research-models label{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:14px}
.research-models label>span{color:var(--dsw-alias-label-secondary)}
.research-models select{width:100%;min-width:0;min-height:40px;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);border-radius:6px;padding:8px}
.research-models select:focus-visible{outline:2px solid var(--dsw-alias-border-selected);outline-offset:2px}
.research-models select:disabled{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);cursor:default}
.research-models__row-note{margin-top:10px!important;font-size:13px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.research-models__footer{position:sticky;bottom:-32px;background:var(--dsw-alias-bg-base);z-index:1;display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:24px;padding-block:16px;border-top:1px solid var(--dsw-alias-border-l2)}
.research-models__footer>div{display:flex;gap:10px}.research-models__footer p{color:var(--dsw-alias-label-secondary)}
.research-models__error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;margin-bottom:12px}
.research-models .research-models__success{color:var(--dsw-alias-state-success-primary)}
.research-models button:disabled{cursor:default}.research-models button.research-panel__primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.research-panel__tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:12px}
.research-panel__tabs button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-selected);font-weight:600}
@media(max-width:720px){.research-models__intro{flex-direction:column}.research-models__fields{grid-template-columns:1fr}.research-models__row{padding:12px}.research-models__footer{bottom:-20px;align-items:flex-start;flex-direction:column}.research-models__footer>div{flex-wrap:wrap}.research-models__footer button{min-height:44px}}
`
