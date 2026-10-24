import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, Send } from 'lucide-react';
import type { PayeeNote } from '../mobile/wallet/send/payee';
import { Theme } from '../theme.types';
import { Button } from './Button';
import { Show } from './Show';
import { PageLoader } from './PageLoader';
import { lineItemLabel } from './sendLineItemLabel';
import { DollarAmount, useSheetPrice } from './DollarAmount';

export type SendLineItem = {
  address: string;
  amount: string; // pre-formatted display string (e.g. "0.005 BSV", "$1.50 MNEE", "100 TOKEN")
  /** Who this is (name, bAvatar, key fingerprint) plus first-payment / look-alike notes. */
  payee?: PayeeNote;
  /** BSV amount in sats: shown dollars first ("4¢") with the sats small underneath, instead of `amount`. */
  sats?: number;
};

const GOLD = '#d4af37';

const Avatar = ({ src, name, size }: { src?: string; name: string; size: number }) =>
  src ? (
    <img src={src} alt="" className="rounded-full object-cover shrink-0" style={{ width: size, height: size }} />
  ) : (
    <span
      className="rounded-full flex items-center justify-center font-bold shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.42, background: 'rgba(212,175,55,0.15)', color: GOLD }}
    >
      {name.replace(/^\$/, '').slice(0, 1).toUpperCase()}
    </span>
  );

export type SendConfirmationProps = {
  show: boolean;
  theme: Theme;
  icon?: string; // token/asset icon URL
  lineItems: SendLineItem[];
  total?: string; // pre-formatted total (e.g. "0.01 BSV")
  /** Total in sats: shown dollars first with the sats underneath, instead of `total`. */
  totalSats?: number;
  /** USD per BSV the screen already has; fetched when missing. Display only. */
  usdPerBsv?: number;
  isProcessing?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export const SendConfirmation = (props: SendConfirmationProps) => {
  const {
    show,
    theme,
    icon,
    lineItems,
    total,
    totalSats,
    usdPerBsv,
    isProcessing = false,
    onConfirm,
    onCancel,
  } = props;
  // Dollars first, sats small underneath (owner, 24 Oct 2026).
  const price = useSheetPrice(usdPerBsv);

  const contrast = theme.color.global.contrast;
  const gray = theme.color.global.gray;
  const bg = theme.color.global.walletBackground;
  const primary = theme.color.component.primaryButtonLeftGradient;

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="flex items-center justify-center"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            backgroundColor: bg,
            zIndex: 100,
          }}
        >
          <Show
            when={isProcessing}
            whenFalseContent={
              <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="flex flex-col items-center text-center px-6 w-full max-w-[420px] mx-auto"
              >
                {/* Icon cluster: asset icon ··· → send icon */}
                <div className="flex items-center gap-3 mb-4">
                  {icon ? (
                    <img src={icon} alt="" className="w-10 h-10 rounded-full object-cover" />
                  ) : (
                    <div
                      className="flex items-center justify-center w-10 h-10 rounded-full"
                      style={{ backgroundColor: `${contrast}12` }}
                    >
                      <Send size={18} style={{ color: contrast }} />
                    </div>
                  )}

                  {/* Animated dots connecting the icons */}
                  <div className="flex items-center" style={{ gap: '6px' }}>
                    {[0, 1, 2].map((i) => (
                      <motion.div
                        key={i}
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          backgroundColor: primary,
                        }}
                        animate={{ opacity: [0.4, 1, 0.4], scale: [0.85, 1.15, 0.85] }}
                        transition={{
                          duration: 1.4,
                          repeat: Infinity,
                          delay: i * 0.25,
                          ease: 'easeInOut',
                        }}
                      />
                    ))}
                  </div>

                  <div
                    className="flex items-center justify-center"
                    style={{ width: 40, height: 40, borderRadius: '50%', backgroundColor: 'rgba(59,130,246,0.15)' }}
                  >
                    <Send size={18} style={{ color: '#3B82F6' }} />
                  </div>
                </div>

                {/* Title */}
                <h2 className="text-xl font-bold mb-4" style={{ color: contrast }}>
                  Confirm Send
                </h2>

                {/* Line items */}
                <div className="w-full mb-4 space-y-3 overflow-y-auto" style={{ maxHeight: '12rem' }}>
                  {lineItems.map((item, i) => (
                    <div
                      key={i}
                      className="flex flex-col gap-2 px-3 py-2 rounded-lg text-sm text-left"
                      style={{ backgroundColor: `${contrast}08` }}
                    >
                      <div className="flex justify-between items-start gap-2">
                        <span className="flex items-center gap-2 min-w-0">
                          {item.payee && (
                            <Avatar src={item.payee.avatar} name={item.payee.name || item.address} size={28} />
                          )}
                          <span className="flex flex-col min-w-0">
                            {item.payee?.name && item.payee.name !== item.address && (
                              <span className="font-semibold truncate" style={{ color: contrast }}>
                                {item.payee.name}
                              </span>
                            )}
                            <span
                              className={/\s/.test(item.address) ? 'break-words' : 'font-mono truncate'}
                              style={{ color: gray }}
                            >
                              {lineItemLabel(item.address)}
                            </span>
                            {item.payee?.fingerprint && (
                              <span className="font-mono text-[10px]" style={{ color: gray }}>
                                Key {item.payee.fingerprint}
                              </span>
                            )}
                          </span>
                        </span>
                        {item.sats !== undefined ? (
                          <span className="shrink-0">
                            <DollarAmount sats={item.sats} price={price} size={20} color={contrast} mutedColor={gray} />
                          </span>
                        ) : (
                          <span className="font-semibold shrink-0 text-right" style={{ color: contrast }}>
                            {item.amount}
                          </span>
                        )}
                      </div>
                      {item.payee?.lookalike && (
                        <div
                          role="alert"
                          className="flex flex-col gap-2 p-2 rounded-lg text-xs"
                          style={{ background: 'rgba(255,68,68,0.12)', color: '#ff6b6b' }}
                        >
                          <span className="flex items-center gap-1 font-bold">
                            <AlertTriangle size={13} /> Look-alike name
                          </span>
                          <div className="flex items-center justify-around gap-2">
                            <span className="flex flex-col items-center gap-1 min-w-0">
                              <Avatar src={item.payee.lookalike.avatar} name={item.payee.lookalike.name} size={32} />
                              <span className="truncate max-w-[7rem]" style={{ color: contrast }}>
                                {item.payee.lookalike.name}
                              </span>
                              <span style={{ color: gray }}>paid before</span>
                            </span>
                            <span style={{ color: gray }}>≠</span>
                            <span className="flex flex-col items-center gap-1 min-w-0">
                              <Avatar src={item.payee.avatar} name={item.payee.name || item.address} size={32} />
                              <span className="truncate max-w-[7rem]" style={{ color: contrast }}>
                                {item.payee.name || item.address}
                              </span>
                              <span style={{ color: gray }}>this payment</span>
                            </span>
                          </div>
                          <span>
                            You've paid {item.payee.lookalike.name} before; this is {item.payee.name || item.address}, a
                            different person. Check before you send.
                          </span>
                        </div>
                      )}
                      {item.payee?.firstTime && (
                        <span className="text-xs" style={{ color: gray }}>
                          First payment to {item.address}
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                {/* Total */}
                <Show when={!!total || totalSats !== undefined}>
                  <div
                    className="flex justify-between items-center w-full px-3 py-2 mb-6 rounded-lg text-sm font-bold"
                    style={{ borderTop: `1px solid ${gray}33` }}
                  >
                    <span style={{ color: gray }}>Total</span>
                    {totalSats !== undefined ? (
                      <DollarAmount sats={totalSats} price={price} size={32} color={contrast} mutedColor={gray} />
                    ) : (
                      <span style={{ color: contrast }}>{total}</span>
                    )}
                  </div>
                </Show>

                <Show when={!total && totalSats === undefined}>
                  <div className="mb-6" />
                </Show>

                {/* Action buttons */}
                <div className="flex items-center gap-3 w-[87%]">
                  <div className="flex-1">
                    <Button theme={theme} type="secondary-outline" label="Cancel" onClick={onCancel} />
                  </div>
                  <div className="flex-1">
                    <Button theme={theme} type="primary" label="Send" onClick={onConfirm} />
                  </div>
                </div>
              </motion.div>
            }
          >
            <PageLoader theme={theme} message="Sending..." />
          </Show>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
