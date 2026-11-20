import type {AppStore} from '../core/store';
import {contributorPage, resolveRecord} from '../core/analyticalSelection';
import {columnIndexToLetter} from '../core/tabular';
import {escapeHtml as esc} from './inspectorUtils';

/** Presentation only: records and aggregates always resolve through the current Store. */
export class DataInspector {
  private abort = new AbortController();
  private pending: AbortController | null = null;
  private dialog: HTMLDialogElement;
  private previousFocus: HTMLElement | null = null;
  private media = matchMedia('(max-width: 1279px)');
  private fieldOffset = 0;
  private cursors = [0];
  private nextCursor: number | null = null;
  private openState = false;
  private textValue = '';
  private inertNodes: Array<{el: HTMLElement; inert: boolean}> = [];
  private disposed = false;
  constructor(private host: HTMLElement, private store: AppStore, private jump: (row: number, col: number) => void, private layout: () => void) {
    host.className = 'data-inspector'; host.hidden = true;
    host.setAttribute('aria-label', 'Data Inspector'); host.tabIndex = -1;
    host.innerHTML = `<header><strong>Data Inspector</strong><button type="button" data-inspect="close" aria-label="Close Inspector">×</button></header>
      <div data-inspector-summary></div><div class="inspector-scroll">
      <div data-record-tools><label>Search record fields<input type="search" aria-label="Search record fields"></label>
      <label><input type="checkbox" data-hide-empty> Hide empty values</label><button data-inspect="copy-row">Copy record JSON</button></div>
      <div data-inspector-fields></div><div data-contributors></div></div><p role="status" data-copy-status></p>`;
    this.dialog = document.createElement('dialog'); this.dialog.className = 'inspector-text-dialog'; this.dialog.setAttribute('aria-label','Full field text');
    this.dialog.innerHTML = '<header><strong>Full field text</strong><button data-text-copy>Copy full text</button><button data-text-close>Close full text</button></header><pre tabindex="0"></pre>';
    document.body.append(this.dialog);
    const signal = this.abort.signal;
    this.dialog.querySelector('[data-text-close]')!.addEventListener('click', () => this.dialog.close(), {signal});
    this.dialog.querySelector('[data-text-copy]')!.addEventListener('click', () => void this.copy(this.textValue), {signal});
    host.querySelector('input[type=search]')!.addEventListener('input', () => {this.fieldOffset = 0; this.renderFields();}, {signal});
    host.querySelector('[data-hide-empty]')!.addEventListener('change', () => {this.fieldOffset = 0; this.renderFields();}, {signal});
    host.addEventListener('click', event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('button'); if (!target) return;
      const action = target.dataset.inspect, selection = store.analyticalSelection;
      if (action === 'close') this.close();
      if (action === 'clear') store.selectCell(null);
      if (action === 'jump' && selection && selection.kind !== 'aggregate') {if(this.media.matches)this.close(); this.jump(selection.rowIndex, selection.colIndex);}
      if (action === 'clear-filter') store.clearSearch();
      if (action === 'filter') void store.filterToSelectionGroup();
      if (action === 'contributors') {this.cursors = [0]; void this.loadContributors();}
      if (action === 'next-records' && this.nextCursor !== null) {this.cursors.push(this.nextCursor); void this.loadContributors();}
      if (action === 'prev-records') {this.cursors.pop(); void this.loadContributors();}
      if (action === 'next-fields') {this.fieldOffset += 20; this.renderFields();}
      if (action === 'prev-fields') {this.fieldOffset = Math.max(0,this.fieldOffset-20); this.renderFields();}
      const row = resolveRecord(store.activeSheet, selection);
      if (action === 'copy-row' && row) void this.copy(JSON.stringify({columns: store.activeSheet.columns, values: row}, null, 2));
      if (target.dataset.copyField !== undefined && row) void this.copy(row[Number(target.dataset.copyField)] ?? '');
      if (target.dataset.fullField !== undefined && row) {
        this.textValue = row[Number(target.dataset.fullField)] ?? '';
        this.dialog.querySelector('pre')!.textContent = this.textValue; this.dialog.showModal();
      }
      if (target.dataset.sourceRow !== undefined && selection) {if(this.media.matches)this.close(); this.jump(Number(target.dataset.sourceRow),selection.colIndex);}
    }, {signal});
    host.addEventListener('keydown', event => {
      if (event.key === 'Escape') {event.stopPropagation(); this.close();}
      if (event.key === 'Tab' && this.media.matches) {
        const nodes = [...host.querySelectorAll<HTMLElement>('button,input,select,[tabindex="0"]')].filter(n=>!n.closest('[hidden]') && !(n as HTMLButtonElement).disabled);
        const first=nodes[0],last=nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
        else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
      }
    }, {signal});
    this.media.addEventListener('change', () => this.syncRole(), {signal});
  }
  toggle(): void {if (this.openState) this.close(); else this.open();}
  open(focus = true): void {
    if (this.openState || this.disposed) return;
    this.previousFocus = document.activeElement as HTMLElement; this.openState=true; this.host.hidden=false;
    this.syncRole(); this.update(); this.layout();
    if (focus) this.host.querySelector<HTMLElement>('button')!.focus();
  }
  close(): void {
    this.openState=false; this.host.hidden=true; this.syncRole(); this.dialog.close(); this.pending?.abort(); this.layout();
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
  }
  private syncRole(): void {
    for (const {el,inert} of this.inertNodes) el.inert=inert;
    this.inertNodes=[];
    if (this.media.matches && this.openState) {
      // Disable the rest of the workspace while this panel behaves as a modal drawer.
      let branch: HTMLElement=this.host;
      while(branch.parentElement && branch.parentElement !== document.body) {
        for(const sibling of branch.parentElement.children) if(sibling !== branch && sibling instanceof HTMLElement) {
          this.inertNodes.push({el:sibling,inert:sibling.inert}); sibling.inert=true;
        }
        branch=branch.parentElement;
      }
    }
    this.host.setAttribute('role',this.media.matches ? 'dialog':'complementary');
    if (this.media.matches) this.host.setAttribute('aria-modal','true'); else this.host.removeAttribute('aria-modal');
  }
  update(): void {
    if (this.disposed) return;
    this.pending?.abort(); this.dialog.close(); this.fieldOffset=0;
    this.host.querySelector('[data-contributors]')!.innerHTML='';
    const s=this.store.analyticalSelection, sheet=this.store.activeSheet;
    const summary=this.host.querySelector('[data-inspector-summary]')!;
    this.host.querySelector<HTMLElement>('[data-record-tools]')!.hidden=!resolveRecord(sheet,s);
    if (!s) summary.innerHTML='<h2>No data selected</h2><p>Select a spreadsheet cell, chart point, or spatial object to inspect its source data.</p>';
    else if (s.kind==='aggregate') summary.innerHTML=`<h2>Selected aggregate</h2><p>${esc(sheet.name)} · ${s.origin.toUpperCase()}</p>
      <dl><dt>Group</dt><dd>${esc(s.label)}</dd><dt>Grouping fields</dt><dd>${esc(s.query?.fields.map(f=>sheet.columns[f.colIndex]).join(', ') ?? 'Combined categories')}</dd>
      <dt>Measure</dt><dd>${esc(sheet.columns[s.colIndex] ?? '')}</dd><dt>Aggregation</dt><dd>${s.aggregation}</dd><dt>Value</dt><dd data-inspector-value>${s.value ?? 'Missing'}</dd>
      <dt>Represented rows</dt><dd>${s.representedRowCount}</dd>${s.excludedCount !== undefined ? `<dt>Invalid / missing excluded</dt><dd>${s.excludedCount}</dd>`:''}</dl>
      ${s.note ? `<p>${esc(s.note)}</p>`:''}<div class="inspector-actions"><button data-inspect="contributors">Inspect contributing records</button>${s.query?.fields.length ? '<button data-inspect="filter">Filter to selected group</button>':''}<button data-inspect="clear">Clear selection</button></div>`;
    else summary.innerHTML=`<h2>Selected ${s.kind === 'chart-point'?'chart point':s.kind === 'spatial-item'?'spatial object':s.kind}</h2><p>${esc(sheet.name)} · ${sheet.rows.length} records</p><dl>
      <dt>Source cell</dt><dd>${columnIndexToLetter(s.colIndex)}${s.rowIndex+1}</dd><dt>Source row</dt><dd>${s.rowIndex+1}</dd><dt>Column</dt><dd>${esc(sheet.columns[s.colIndex] ?? '')}</dd>
      <dt>Value</dt><dd data-inspector-value>${esc((sheet.rows[s.rowIndex]?.[s.colIndex] ?? '').slice(0,160))}${(sheet.rows[s.rowIndex]?.[s.colIndex]?.length ?? 0)>160?'… (full text below)':''}</dd></dl>
      <div class="inspector-actions"><button data-inspect="jump">Jump to source</button><button data-inspect="clear">Clear selection</button></div>`;
    if (this.store.groupFilterLabel) summary.insertAdjacentHTML('beforeend',`<p>Group filter: ${esc(this.store.groupFilterLabel)}</p><button data-inspect="clear-filter">Clear group filter</button>`);
    this.renderFields();
  }
  private renderFields(): void {
    const s=this.store.analyticalSelection,sheet=this.store.activeSheet,row=resolveRecord(sheet,s),el=this.host.querySelector('[data-inspector-fields]')!;
    if (!row) {el.innerHTML='';return;}
    const query=this.host.querySelector<HTMLInputElement>('input[type=search]')!.value.toLowerCase();
    const hide=this.host.querySelector<HTMLInputElement>('[data-hide-empty]')!.checked;
    const fields=sheet.columns.map((name,index)=>({name,index,value:row[index] ?? ''})).filter(f=>(!hide || f.value.trim()) && f.name.toLowerCase().includes(query));
    el.innerHTML=fields.slice(this.fieldOffset,this.fieldOffset+20).map(f=>`<section class="inspector-field ${s?.colIndex === f.index?'selected-field':''}" aria-label="${esc(f.name)} field">
      <strong>${esc(f.name)}</strong><small>${esc(this.store.datasetProfile.columns[f.index]?.roleOverride ?? this.store.datasetProfile.columns[f.index]?.semanticType ?? sheet.types[f.index])}</small>
      <p>${esc(f.value.slice(0,160))}${f.value.length>160?'…':''}${!f.value?'<em>Empty</em>':''}</p><button data-copy-field="${f.index}" aria-label="Copy ${esc(f.name)}">Copy value</button>
      ${f.value.length>160 || f.value.includes('\n')?`<button data-full-field="${f.index}" aria-label="View full ${esc(f.name)}">Full text</button>`:''}</section>`).join('') +
      `<div class="inspector-actions">${this.fieldOffset ? '<button data-inspect="prev-fields">Previous fields</button>':''}${this.fieldOffset+20<fields.length?'<button data-inspect="next-fields">Next fields</button>':''}<span>${fields.length} fields</span></div>`;
  }
  private async loadContributors(): Promise<void> {
    const s=this.store.analyticalSelection; if (!s || s.kind!=='aggregate') return;
    this.pending?.abort(); const pending=this.pending=new AbortController();
    const el=this.host.querySelector('[data-contributors]')!; el.innerHTML='<p role="status">Loading contributing records…</p>';
    try {
      const page=await contributorPage(this.store.activeSheet,this.store.visibleRowIndices,s,this.cursors.at(-1),20,pending.signal);
      if(pending.signal.aborted)return; this.nextCursor=page.nextCursor;
      el.innerHTML=`<h3>Contributing records</h3>${page.partial?'<p>Bounded source preview; not the complete group.</p>':''}<ol>${page.rows.map(r=>`<li><button data-source-row="${r}">Source row ${r+1}</button> <span>${esc(this.store.activeSheet.rows[r][s.colIndex] ?? '')}</span></li>`).join('')}</ol><div class="inspector-actions">${this.cursors.length>1?'<button data-inspect="prev-records">Previous records</button>':''}${page.nextCursor!==null?'<button data-inspect="next-records">Next records</button>':''}</div>`;
    } catch(error) {if(!pending.signal.aborted) el.textContent=`Unable to load records: ${String(error)}`;}
  }
  private async copy(value:string): Promise<void> {
    const status=this.host.querySelector('[data-copy-status]')!;
    try {await navigator.clipboard.writeText(value);if(!this.disposed) status.textContent='Copied';} catch {status.textContent='Clipboard unavailable. Open full text to select and copy manually.';}
  }
  dispose(): void {this.disposed=true; this.openState=false; this.syncRole(); this.host.hidden=true; this.abort.abort();this.pending?.abort();this.dialog.remove();this.host.replaceChildren();}
}
