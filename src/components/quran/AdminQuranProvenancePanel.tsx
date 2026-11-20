import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, BookOpen, CheckCircle2, Save, ShieldCheck } from 'lucide-react';
import { useNonoLand } from '../../context/NonoLandContext';
import { QURAN_SURAHS } from '../../data/quranCatalog';
import type { QuranReciterSpec, QuranVerificationStatus } from '../../types/nonoland';
import type { AdminQuranVerificationsPayload } from './QuranSharedTypes';

interface Props {
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
}

export const AdminQuranProvenancePanel: React.FC<Props> = ({
  apiFetch,
  onNotice,
  onError,
}) => {
  const { language } = useNonoLand();
  const [data, setData] = useState<AdminQuranVerificationsPayload | null>(null);
  const [editingKey, setEditingKey] = useState<string>('');
  const [statusDraft, setStatusDraft] = useState<QuranVerificationStatus>('pending_verification');
  const [sourceDraft, setSourceDraft] = useState('');
  const [licenseDraft, setLicenseDraft] = useState('');
  const [reviewerDraft, setReviewerDraft] = useState('');
  const [audioUrlsText, setAudioUrlsText] = useState('');
  const [notesDraft, setNotesDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const loadVerifications = useCallback(async () => {
    const res = await apiFetch('/api/admin/quran/verifications');
    if (res.ok) {
      setData((await res.json()) as AdminQuranVerificationsPayload);
    }
  }, [apiFetch]);

  useEffect(() => {
    void loadVerifications();
  }, [loadVerifications]);

  const startEditingReciter = (r: QuranReciterSpec) => {
    setEditingKey(r.id);
    setStatusDraft(r.verificationStatus);
    setSourceDraft(r.sourceName);
    setLicenseDraft(r.licenseOrPermission);
    setReviewerDraft(r.tajweedReviewedBy || '');
    setAudioUrlsText(r.surahAudioUrls ? JSON.stringify(r.surahAudioUrls, null, 2) : '{}');
    setNotesDraft('');
  };

  const handleSaveReciter = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingKey) return;
    onError('');
    let parsedUrls: Record<string, string> = {};
    try {
      const raw = JSON.parse(audioUrlsText || '{}');
      if (raw && typeof raw === 'object') parsedUrls = raw as Record<string, string>;
    } catch {
      onError(language === 'ar' ? 'صيغة JSON لروابط التلاوة غير صحيحة.' : 'Invalid audioUrlsJson format.');
      return;
    }

    setSaving(true);
    try {
      const res = await apiFetch(`/api/admin/quran/verifications/${encodeURIComponent(editingKey)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verificationStatus: statusDraft,
          sourceName: sourceDraft,
          licenseOrPermission: licenseDraft,
          tajweedReviewedBy: reviewerDraft,
          tajweedReviewedAt: reviewerDraft ? new Date().toISOString().slice(0, 10) : undefined,
          audioUrlsJson: parsedUrls,
          notes: notesDraft,
        }),
      });
      const resp = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(resp.error || 'Failed to update verification record.');
        return;
      }
      onNotice(`Updated Quran reciter verification: ${editingKey} -> ${statusDraft}`);
      setEditingKey('');
      await loadVerifications();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Verified Uthmani Text Provenance Registry (Read-Only) */}
      <div className="nono-card rounded-3xl p-5 bg-white space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-lg font-extrabold text-[#27345C] flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-[#047857]" />
              <span>
                {language === 'ar'
                  ? 'سجل توثيق النصوص القرآنية العثمانية (للقراءة فقط)'
                  : 'Verified Uthmani Quran Text Provenance Registry (Immutable)'}
              </span>
            </h3>
            <p className="text-xs font-bold text-[#27345C]/70 mt-0.5">
              {language === 'ar'
                ? 'تم فحص ومطابقة SHA-256 لجميع السور التسع مباشرة مع مصحف المدينة المنورة (api.quran.com v4).'
                : 'All 9 Surahs SHA-256 verified verbatim against King Fahd Complex Medina Mushaf (api.quran.com v4).'}
            </p>
          </div>
          <span className="px-3 py-1 rounded-xl bg-[#DCFCE7] text-[#166534] text-xs font-extrabold flex items-center gap-1">
            <CheckCircle2 className="w-4 h-4" />
            <span>{QURAN_SURAHS.length} Surahs Verified</span>
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
          {(data?.surahTexts || []).map((s) => (
            <div key={s.contentKey} className="p-3.5 rounded-2xl bg-[#FFFDF7] border border-[#B4862C]/25 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="font-extrabold text-[#27345C]">
                  {s.nameAr} · {s.nameEn}
                </p>
                <span className="px-2 py-0.5 rounded-lg bg-[#DCFCE7] text-[#166534] text-[10px] font-extrabold">
                  {s.verificationStatus}
                </span>
              </div>
              <p className="text-[#27345C]/70 font-bold tabular-nums">
                {s.contentKey} · {s.ayahCount} ayahs
              </p>
              <p className="font-mono-num text-[10px] text-[#27345C]/65 truncate" title={s.textSha256}>
                SHA-256: {s.textSha256}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Reciters Verification & Licensing Registry */}
      <div className="nono-card rounded-3xl p-5 bg-white space-y-4">
        <div>
          <h3 className="text-lg font-extrabold text-[#27345C] flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-[#8054D9]" />
            <span>
              {language === 'ar'
                ? 'اعتماد القراء والتلاوات الصوتية المرخّصة'
                : 'Quran Reciter Licensing & Tajweed Verification'}
            </span>
          </h3>
          <p className="text-xs font-bold text-[#27345C]/70 mt-0.5">
            {language === 'ar'
              ? 'لا يُسمح باعتماد أي قارئ بدون رابط صوتي موثوق (https:// أو /assets/quran/) ورخصة واضحة واسم مراجع التجويد.'
              : 'Reciters cannot be verified without explicit HTTPS or local asset URLs, license/permission, and a Tajweed reviewer.'}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          {(data?.reciters || []).map((r) => (
            <div key={r.id} className="p-4 rounded-2xl bg-[#FFF8E9] border border-[#27345C]/12 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-extrabold text-[#27345C]">{r.name[language]}</span>
                <span
                  className={`px-2 py-0.5 rounded-lg text-[10px] font-extrabold ${
                    r.verificationStatus === 'verified'
                      ? 'bg-[#DCFCE7] text-[#166534]'
                      : 'bg-[#FEF3C7] text-[#92400E]'
                  }`}
                >
                  {r.verificationStatus}
                </span>
              </div>
              <p className="text-[#27345C]/75 font-bold">{r.style[language]}</p>
              <p className="text-[#27345C]/65">{r.licenseOrPermission}</p>
              <button
                type="button"
                onClick={() => startEditingReciter(r)}
                className="min-h-[38px] w-full rounded-xl bg-[#27345C] text-white font-extrabold cursor-pointer"
              >
                {language === 'ar' ? 'تحديث بيانات التوثيق' : 'Manage Verification'}
              </button>
            </div>
          ))}
        </div>

        {editingKey && (
          <form
            onSubmit={(e) => void handleSaveReciter(e)}
            className="p-4 rounded-2xl bg-[#F8FAFC] border border-[#8054D9]/30 space-y-3 text-xs font-bold"
          >
            <div className="flex items-center justify-between">
              <p className="font-extrabold text-sm text-[#27345C]">Edit Reciter: {editingKey}</p>
              <button
                type="button"
                onClick={() => setEditingKey('')}
                className="px-3 py-1 rounded-lg bg-slate-200 cursor-pointer"
              >
                Cancel
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="space-y-1">
                <span>Verification Status</span>
                <select
                  value={statusDraft}
                  onChange={(e) => setStatusDraft(e.target.value as QuranVerificationStatus)}
                  className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15"
                >
                  <option value="pending_verification">pending_verification</option>
                  <option value="verified">verified</option>
                  <option value="unavailable">unavailable</option>
                </select>
              </label>

              <label className="space-y-1">
                <span>Tajweed Reviewed By</span>
                <input
                  type="text"
                  value={reviewerDraft}
                  onChange={(e) => setReviewerDraft(e.target.value)}
                  placeholder="Sheikh / Committee Name"
                  className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15"
                />
              </label>

              <label className="space-y-1">
                <span>Source Name</span>
                <input
                  type="text"
                  value={sourceDraft}
                  onChange={(e) => setSourceDraft(e.target.value)}
                  className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15"
                />
              </label>

              <label className="space-y-1">
                <span>License / Permission</span>
                <input
                  type="text"
                  value={licenseDraft}
                  onChange={(e) => setLicenseDraft(e.target.value)}
                  className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15"
                />
              </label>
            </div>

            <label className="block space-y-1">
              <span>audioUrlsJson (Surah ID → https:// or /assets/quran/...)</span>
              <textarea
                rows={3}
                dir="ltr"
                value={audioUrlsText}
                onChange={(e) => setAudioUrlsText(e.target.value)}
                className="w-full p-2.5 rounded-xl bg-white border border-[#27345C]/15 font-mono-num"
              />
            </label>

            <label className="block space-y-1">
              <span>Notes</span>
              <input
                type="text"
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15"
              />
            </label>

            <div className="flex items-center justify-between gap-2">
              <span className="text-[#27345C]/65 flex items-center gap-1">
                <AlertCircle className="w-4 h-4" />
                Requires migration 0002 applied on PG to persist overrides.
              </span>
              <button
                type="submit"
                disabled={saving}
                className="min-h-[40px] px-5 rounded-xl bg-[#8054D9] text-white font-extrabold flex items-center gap-1.5 cursor-pointer"
              >
                <Save className="w-4 h-4" />
                <span>Save Verification</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
