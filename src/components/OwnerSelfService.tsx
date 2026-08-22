import React, { useEffect, useState } from 'react';
import { Business, KnowledgeChunk } from '../types';

/**
 * Task 31 — owner self-service business data management.
 *
 * Two presentational components for the BUSINESS_OWNER portal:
 *  - BusinessProfileEditor: edit the business profile, services, and opening
 *    hours via the EXISTING PUT /businesses/:id route (the agent reads these
 *    live through the existing tools — no second data store, no cache).
 *  - KnowledgeManager: list existing knowledge with a Delete action per entry
 *    via the EXISTING tenant-scoped DELETE /knowledge/:id route (which already
 *    removes the embedding). Lets the owner remove an incorrect fact without
 *    developer/DB intervention.
 *
 * Both are display-only: validation, tenant scope, and persistence stay
 * server-side. No HTML injection, no client-controlled tenant authority.
 */

// ---------------------------------------------------------------------------
// Business profile / services / hours editor
// ---------------------------------------------------------------------------

export interface BusinessProfileEditorProps {
  business: Business;
  saving: boolean;
  saveError: string | null;
  /** True only after the server confirmed the save. */
  saved: boolean;
  onSave: (updates: {
    name: string;
    description: string;
    location: string;
    pricingNotes: string;
    services: { id: string; name: string; price: number; durationMinutes: number }[];
    hours: { day: string; isOpen: boolean; openTime: string; closeTime: string }[];
  }) => void;
}

const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export const BusinessProfileEditor: React.FC<BusinessProfileEditorProps> = ({
  business, saving, saveError, saved, onSave
}) => {
  const [name, setName] = useState(business.name);
  const [description, setDescription] = useState(business.description || '');
  const [location, setLocation] = useState(business.location || '');
  const [pricingNotes, setPricingNotes] = useState((business as any).pricingNotes || '');
  const [services, setServices] = useState(
    (business.services || []).map(s => ({ id: s.id, name: s.name, price: String(s.price), durationMinutes: String(s.durationMinutes) }))
  );
  const [hours, setHours] = useState(
    DAY_ORDER.map(day => {
      const h = (business.hours || []).find((x: any) => x.day === day);
      return { day, isOpen: h?.isOpen ?? false, openTime: h?.openTime || '09:00', closeTime: h?.closeTime || '17:00' };
    })
  );

  const setService = (i: number, field: 'name' | 'price' | 'durationMinutes', value: string) => {
    setServices(s => s.map((svc, idx) => (idx === i ? { ...svc, [field]: value } : svc)));
  };
  const setHour = (i: number, field: 'isOpen' | 'openTime' | 'closeTime', value: string | boolean) => {
    setHours(h => h.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)));
  };

  const handleSave = () => {
    onSave({
      name: name.trim() || business.name,
      description: description.trim(),
      location: location.trim(),
      pricingNotes: pricingNotes.trim(),
      services: services
        .filter(s => s.name.trim())
        .map(s => ({
          id: s.id,
          name: s.name.trim(),
          price: Number(s.price) || 0,
          durationMinutes: Number(s.durationMinutes) || 30
        })),
      hours: hours.map(h => ({ day: h.day, isOpen: h.isOpen, openTime: h.openTime, closeTime: h.closeTime }))
    });
  };

  return (
    <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-5">
      <h3 className="font-bold text-slate-900 text-sm">Business Profile</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-slate-500">Business name</span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className="mt-1 w-full px-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="text-xs text-slate-500">Location</span>
          <input
            value={location}
            onChange={e => setLocation(e.target.value)}
            className="mt-1 w-full px-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none"
          />
        </label>
      </div>
      <label className="block">
        <span className="text-xs text-slate-500">Description</span>
        <textarea
          rows={2}
          value={description}
          onChange={e => setDescription(e.target.value)}
          className="mt-1 w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none"
        />
      </label>
      <label className="block">
        <span className="text-xs text-slate-500">Pricing notes</span>
        <input
          value={pricingNotes}
          onChange={e => setPricingNotes(e.target.value)}
          className="mt-1 w-full px-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none"
        />
      </label>

      <div>
        <h4 className="font-semibold text-slate-800 text-xs mb-2">Services</h4>
        <div className="space-y-2">
          {services.map((s, i) => (
            <div key={s.id} className="grid grid-cols-[1fr_80px_90px] gap-2 items-center">
              <input
                aria-label={`Service ${i + 1} name`}
                value={s.name}
                onChange={e => setService(i, 'name', e.target.value)}
                className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs"
              />
              <input
                aria-label={`Service ${i + 1} price`}
                type="number"
                value={s.price}
                onChange={e => setService(i, 'price', e.target.value)}
                className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs"
              />
              <input
                aria-label={`Service ${i + 1} duration (min)`}
                type="number"
                value={s.durationMinutes}
                onChange={e => setService(i, 'durationMinutes', e.target.value)}
                className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs"
              />
            </div>
          ))}
          {services.length === 0 && <div className="text-xs text-slate-400">No services configured.</div>}
        </div>
        <button
          onClick={() => setServices(s => [...s, { id: `srv-${Date.now()}`, name: '', price: '0', durationMinutes: '30' }])}
          className="mt-2 px-3 py-1 text-xs font-semibold bg-slate-100 text-slate-700 rounded-lg"
        >
          + Add service
        </button>
      </div>

      <div>
        <h4 className="font-semibold text-slate-800 text-xs mb-2">Opening Hours</h4>
        <div className="space-y-1">
          {hours.map((h, i) => (
            <div key={h.day} className="grid grid-cols-[90px_70px_1fr_1fr] gap-2 items-center text-xs">
              <span className="capitalize text-slate-600">{h.day}</span>
              <label className="flex items-center gap-1 text-slate-600">
                <input type="checkbox" checked={h.isOpen} onChange={e => setHour(i, 'isOpen', e.target.checked)} />
                open
              </label>
              <input type="time" value={h.openTime} disabled={!h.isOpen} onChange={e => setHour(i, 'openTime', e.target.value)} className="px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg disabled:opacity-40" />
              <input type="time" value={h.closeTime} disabled={!h.isOpen} onChange={e => setHour(i, 'closeTime', e.target.value)} className="px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg disabled:opacity-40" />
            </div>
          ))}
        </div>
      </div>

      {saveError && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{saveError}</div>}
      {saved && !saveError && <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">Saved.</div>}

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-semibold disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save changes'}
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Knowledge manager (list + delete)
// ---------------------------------------------------------------------------

export interface KnowledgeManagerProps {
  items: KnowledgeChunk[];
  deletingId: string | null;
  onDelete: (id: string) => void;
}

export const KnowledgeManager: React.FC<KnowledgeManagerProps> = ({ items, deletingId, onDelete }) => {
  return (
    <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-3">
      <h3 className="font-bold text-slate-900 text-sm">Knowledge Base</h3>
      {items.length === 0 && <div className="text-xs text-slate-400">No knowledge yet — add facts/policies above so the agent can answer accurately.</div>}
      <div className="space-y-2">
        {items.map(item => (
          <div key={item.id} className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between text-xs">
            <div className="min-w-0">
              <p className="font-bold text-slate-900 truncate">{item.title}</p>
              <p className="text-slate-500 truncate">{item.type}</p>
            </div>
            <button
              onClick={() => onDelete(item.id)}
              disabled={deletingId === item.id}
              className="px-3 py-1 text-xs font-semibold bg-red-50 text-red-700 border border-red-200 rounded-lg disabled:opacity-50 shrink-0"
            >
              {deletingId === item.id ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
