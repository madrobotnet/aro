import { BRAND_MARK_PATH, BRAND_MARK_VIEWBOX } from "@/lib/brand";
import { cn } from "./cn";

export type BrandMarkProps = { className?: string };

/**
 * Aro rounded tile with 아 knocked out, drawn in currentColor. Defaults come from `.brand-mark` in globals.css
 * (20px, accent, no shrink). They sit in the components layer, so any size-* or text-* utility
 * passed here wins. Decorative: show the brand name beside it or name the enclosing link/button.
 */
export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg aria-hidden="true" viewBox={BRAND_MARK_VIEWBOX} fill="currentColor" className={cn("brand-mark", className)}>
      <path fillRule="evenodd" d={BRAND_MARK_PATH} />
    </svg>
  );
}
