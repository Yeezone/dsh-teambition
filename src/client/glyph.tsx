/**
 * Sidebar row glyph of the Teambition panel.
 *
 * The shell owns the row button, its label, tooltip and rail geometry; this
 * component draws only the glyph, like every other panel row. It carries
 * `data-dsh-panel-entry` because it is the only DOM the panel owns inside that
 * shell-owned row: the L2 contract (skins) resolves which row belongs to which
 * plugin through that attribute.
 *
 * @module @yeezone/dsh-client-ui-teambition/client/glyph
 */
import type { ReactElement } from 'react'
import { TEAMBITION_PANEL_ID } from '../core/protocol.ts'

/**
 * The Teambition glyph: a rounded board square split into a header strip and a
 * task check mark, drawn in the shell's current foreground color.
 * @param props - the shell's icon share: square edge and selection state.
 * @returns the decorative panel glyph.
 */
export function TeambitionPanelIcon({ size }: { size: number; active: boolean }): ReactElement {
  return (
    <svg
      data-dsh-panel-entry={TEAMBITION_PANEL_ID}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="1.8" />
      <path d="M2 6.2h12" />
      <path d="M5.2 9.2l1.6 1.6 3.2-3.2" />
    </svg>
  )
}
