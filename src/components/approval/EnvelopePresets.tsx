import { CARD } from './cardTheme';
import { envelopeUsdText } from '../../services/envelopes';

/**
 * The envelope amount picker (services/envelopes.ts): one tap per preset, wrapping, never a sideways strip.
 * `allowNone` adds "No envelope" first (a pay sheet's top-up is opt-in).
 */
export const EnvelopePresets = (props: {
  presetsUsd: readonly number[];
  value: number;
  onChange: (usd: number) => void;
  allowNone?: boolean;
  disabled?: boolean;
}) => {
  const choices = props.allowNone ? [0, ...props.presetsUsd] : [...props.presetsUsd];
  return (
    <div className="flex flex-wrap" style={{ gap: 8 }} role="radiogroup" aria-label="Envelope amount">
      {choices.map((usd) => {
        const on = props.value === usd;
        return (
          <button
            key={usd}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={props.disabled}
            onClick={() => props.onChange(usd)}
            style={{
              minHeight: 44,
              padding: '0 16px',
              borderRadius: 22,
              border: `1.5px solid ${on ? CARD.gold : CARD.chip}`,
              background: on ? CARD.gold : CARD.chip,
              color: on ? CARD.bg : CARD.ink,
              fontSize: usd ? 16 : 14,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {usd ? envelopeUsdText(usd) : 'No envelope'}
          </button>
        );
      })}
    </div>
  );
};
