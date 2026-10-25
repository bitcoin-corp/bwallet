import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useBackClose } from '../backStack';

const GOLD = 'var(--bw-accent-hi)';
const BG = '#17191E';
const LINE = '#2b2f36';

/** One bottom sheet: what happens, what it costs, one button. Nothing is signed before the button. */
export const ConfirmSheet = ({
  title,
  rows,
  note,
  action,
  disabled,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  rows: readonly (readonly [string, string])[];
  note?: string;
  action: string;
  disabled?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) => {
  useBackClose(!busy, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-end bg-black/60" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-label={title}
        className="w-full rounded-t-2xl px-5 pt-5 flex flex-col gap-3 border-t"
        style={{ background: BG, borderColor: LINE, paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="text-base font-bold text-white break-words min-w-0">{title}</div>
          <button aria-label="Close" onClick={onClose} disabled={busy} className="p-1">
            <X size={18} color="#98A2B3" />
          </button>
        </div>
        <div className="flex flex-col gap-1.5 rounded-xl p-3" style={{ background: '#0F1013' }}>
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 text-sm">
              <span className="text-[#98A2B3]">{k}</span>
              <span className="text-white text-right break-words min-w-0">{v}</span>
            </div>
          ))}
        </div>
        {note && <p className="text-[11px] leading-relaxed text-[#667085] m-0">{note}</p>}
        <button
          type="button"
          disabled={disabled || busy}
          onClick={onConfirm}
          className="h-12 rounded-xl text-sm font-bold disabled:opacity-40"
          style={{ background: GOLD, color: '#010101' }}
        >
          {busy ? 'Working…' : action}
        </button>
      </div>
    </div>,
    document.body,
  );
};
