// Shared observing list (server-side, the same on every device): GoTo, mark observed with a note, reorder,
// remove. Used by the desktop "List" panel and the phone remote's List tab.
import { useState } from 'react';
import type { ObservingListEntry, Target } from '@stargazer/shared/api.ts';
import { sameTarget } from '@stargazer/shared/observingList.ts';
import { useLocation, useStore } from '../state/store.ts';
import { useGotoBlocker, useNow, useSun } from '../state/hooks.ts';
import { mountLimits, sunIsUp } from '../lib/safety.ts';
import { targetVisibility } from '../lib/visibility.ts';
import { compassPoint, fmtDeg, fmtTime } from '../lib/format.ts';
import { Icon, Section, Toggle } from './ui.tsx';

function kindLabel(e: ObservingListEntry): string {
  const t = e.target;
  if (t.kind === 'body') return t.body === 'Moon' ? 'Moon' : 'Planet';
  if (t.kind === 'altaz') return 'Fixed direction';
  return t.id && t.id !== e.name ? t.id : 'Sky object';
}

export function ListPanel() {
  const list = useStore((s) => s.observingList);
  const send = useStore((s) => s.send);
  const requestGoto = useStore((s) => s.requestGoto);
  const mount = useStore((s) => s.mount);
  const blocker = useGotoBlocker();
  const loc = useLocation();
  const now = useNow(30000);
  const sun = useSun();
  const limits = mountLimits(mount);
  const [hideObserved, setHideObserved] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (list === null) {
    return (
      <div className="panel-body">
        <Section title="Observing list"><div className="note warn">This server doesn't support the shared observing list yet. Update Stargazer on the laptop.</div></Section>
      </div>
    );
  }
  const open = list.filter((e) => !e.observedAt).length;
  const shown = hideObserved ? list.filter((e) => !e.observedAt) : list;
  const startEdit = (e: ObservingListEntry, markObserved: boolean) => {
    setEditing(e.id);
    setDraft(e.note ?? '');
    if (markObserved && !e.observedAt) send({ type: 'listMarkObserved', id: e.id, observed: true });
  };
  const saveNote = (e: ObservingListEntry) => {
    send({ type: 'listMarkObserved', id: e.id, observed: !!e.observedAt, note: draft });
    setEditing(null);
  };

  return (
    <div className="panel-body">
      <Section title="Observing list" right={<span className="dim small">{open} to see · {list.length - open} seen</span>}>
        <div className="note dim small">Shared by every device on this server: add objects from Search, Tonight or the object card.</div>
        {list.some((e) => e.observedAt) && <Toggle on={hideObserved} onChange={setHideObserved} label="Hide observed" />}
      </Section>
      <ol className="obs-list">
        {shown.map((e) => {
          const i = list.indexOf(e);
          const vis = targetVisibility(e.target, loc, now, limits, (t) => fmtTime(t));
          const block = blocker(e.target);
          return (
            <li key={e.id} className={`obs-item ${e.observedAt ? 'observed' : ''}`} data-id={e.id}>
              <div className="obs-row">
                <button className={`obs-check ${e.observedAt ? 'on' : ''}`} aria-pressed={!!e.observedAt} title={e.observedAt ? `Observed ${fmtTime(e.observedAt)}: tap to unmark` : 'Mark observed'}
                  onClick={() => (e.observedAt ? send({ type: 'listMarkObserved', id: e.id, observed: false }) : startEdit(e, true))}>
                  <Icon name="check" size={16} />
                </button>
                <div className="obs-main">
                  <div className="obs-name">{e.name}</div>
                  <div className="obs-meta dim small">
                    {kindLabel(e)}
                    {vis && <> · <span className={`vis vis-${vis.level}`}>{vis.alt >= 0 ? `${fmtDeg(vis.alt, 0)} ${compassPoint(vis.az)}` : ''} {vis.label}</span></>}
                    {e.observedAt && <> · seen {fmtTime(e.observedAt)}</>}
                  </div>
                  {e.note && editing !== e.id && <div className="obs-note small">“{e.note}”</div>}
                </div>
                <span className="btn-wrap" title={block ?? `GoTo ${e.name}`}>
                  <button className="btn small primary obs-goto" disabled={!!block} onClick={() => requestGoto(e.target, { daytime: sunIsUp(sun.alt, limits) })}>GoTo</button>
                </span>
              </div>
              {block && !e.observedAt && <div className="dim small block-reason">{block}</div>}
              {editing === e.id ? (
                <div className="obs-edit">
                  <textarea className="input" rows={2} value={draft} placeholder="Note (seeing, eyepiece, what you saw…)" onChange={(ev) => setDraft(ev.target.value)} autoFocus
                    onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) saveNote(e); if (ev.key === 'Escape') setEditing(null); }} />
                  <div className="row-actions">
                    <button className="btn small" onClick={() => setEditing(null)}>Cancel</button>
                    <button className="btn small primary" onClick={() => saveNote(e)}>Save note</button>
                  </div>
                </div>
              ) : (
                <div className="obs-actions">
                  <button className="icon-btn" title="Note" aria-label={`Note for ${e.name}`} onClick={() => startEdit(e, false)}><Icon name="edit" size={15} /></button>
                  <button className="icon-btn" title="Move up" aria-label={`Move ${e.name} up`} disabled={i === 0} onClick={() => send({ type: 'listMove', id: e.id, index: i - 1 })}><Icon name="arrowUp" size={15} /></button>
                  <button className="icon-btn" title="Move down" aria-label={`Move ${e.name} down`} disabled={i === list.length - 1} onClick={() => send({ type: 'listMove', id: e.id, index: i + 1 })}><Icon name="arrowDown" size={15} /></button>
                  <button className="icon-btn" title="Remove from list" aria-label={`Remove ${e.name}`} onClick={() => send({ type: 'listRemove', id: e.id })}><Icon name="trash" size={15} /></button>
                </div>
              )}
            </li>
          );
        })}
        {list.length === 0 && <li className="note dim">Your list is empty. Use <b>Add to list</b> in Search, Tonight or on an object card.</li>}
        {list.length > 0 && shown.length === 0 && <li className="note dim">Everything on the list has been observed. Nice!</li>}
      </ol>
    </div>
  );
}

/** "Add to list" / "On list" button for a target. */
export function AddToListButton({ target, small, label = true }: { target: Target; small?: boolean; label?: boolean }) {
  const list = useStore((s) => s.observingList);
  const addToList = useStore((s) => s.addToList);
  const on = !!list?.some((e) => sameTarget(e.target, target));
  return (
    <button className={`btn ${small ? 'small' : ''} add-list ${on ? 'on' : ''}`} disabled={on || list === null} onClick={(ev) => { ev.stopPropagation(); addToList(target); }}
      title={list === null ? 'This server has no observing list' : on ? 'Already on your observing list' : 'Add to the shared observing list'} aria-label={on ? `${target.name} is on your list` : `Add ${target.name} to list`}>
      <Icon name={on ? 'bookmarkOn' : 'bookmarkAdd'} size={small ? 14 : 16} />{label && (on ? ' On list' : ' Add to list')}
    </button>
  );
}
