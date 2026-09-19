/**
 * Close an anchored Plan popover on outside pointerdown or Escape.
 * - Capture phase, so an outside click cancels before any blur-driven save.
 * - The anchor (root's parent) counts as inside, so re-clicking it toggles normally.
 * @module pages/plan/usePopoverDismiss
 */
import { useEffect, useRef } from 'react';
/** @param {object} root Ref to the popover element. @param {Function} onClose Close callback. @returns {object} Ref that turns true once dismissed. */
export default function usePopoverDismiss(root, onClose) {
  const dismissed = useRef(false);
  useEffect(() => {
    const cancel = () => {
      if (dismissed.current) return;
      dismissed.current = true;
      onClose();
    };
    const outside = e => {
      if (root.current && !root.current.parentElement.contains(e.target)) cancel();
    };
    const esc = e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', esc, true);
    };
  }, [root, onClose]);
  return dismissed;
}
