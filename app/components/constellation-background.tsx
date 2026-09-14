/**
 * ConstellationBackground — decorative ThreeUI particle constellation
 * rendered as a full-page background layer.
 *
 * This is a client component because ConstellationField from
 * @designcodeio/threeui uses Three.js/WebGL and requires browser APIs.
 *
 * It must remain:
 * - Behind all content (z-index: -1, pointer-events: none)
 * - Non-interactive
 * - aria-hidden (decorative only)
 * - Responsive (fills viewport, no overflow)
 *
 * Visual concept: particle constellation reinforces the relationship/
 * evidence metaphor (manuscript → repository → evidence → decision)
 * without distracting from the Proofline content.
 */

'use client';

import { ConstellationField } from '@designcodeio/threeui';
import '@designcodeio/threeui/style.css';

export function ConstellationBackground() {
  return (
    <div
      className="proofline-constellation"
      aria-hidden="true"
      role="presentation"
    >
      <ConstellationField
        mode="dark"
        speed={1.0}
        size={1.0}
        strokeWidth={1.0}
        length={1.0}
        density={1.0}
        opacity={1.0}
        hue={0}
        saturation={1.0}
        brightness={1.0}
      />
    </div>
  );
}