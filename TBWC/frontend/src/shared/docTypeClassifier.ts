/**
 * Shared doc-type auto-classification for TBWC — one rule set used by both
 * the bulk Document Import panel (features/documentImport/DocumentImportPanel.tsx)
 * and DocumentsGrid's drag-and-drop / folder-add (via its classifyDocType prop),
 * so a file gets the same type whether it arrives through the folder importer
 * or is dropped straight onto an order/invoice/inventory record.
 *
 * Only filename + immediate-folder-name rules live here — DocumentImportPanel
 * layers its own PO-number-match rule on top (rule 16 in its doc comment),
 * since that needs the resolved order/PO context this module doesn't have.
 */
import type { DocType } from '@meterit/framework-frontend/documents';

/** Extensions treated as photos for the image fallback rule. */
const IMAGE_EXT = /\.(jpe?g|png|gif|heic|heif|bmp|tiff?|webp)$/i;

/** True for file names classifyDocType() would otherwise fall through on, that are photos. */
export function isImageFile(fileName: string): boolean {
  return IMAGE_EXT.test(fileName);
}

/**
 * Matches `word` as a standalone token: not touching a LETTER on either side,
 * but fine right next to digits/punctuation/spaces/start-or-end-of-string —
 * so "RMA123456" matches "rma" but "Information" doesn't (the "rma" inside it
 * is wedged between two letters). A plain substring/word-boundary check can't
 * get both right at once: \b treats digits as "word" characters too, so
 * \brma\b silently rejects "RMA123456" (no boundary between "A" and "1").
 */
function wordLike(word: string): RegExp {
  return new RegExp(`(?<![a-z])(?:${word})(?![a-z])`, 'i');
}
const RMA_RE = wordLike('rma');
const METER_RE = wordLike('meters?');
const BOM_RE = wordLike('bom');
const DNET_RE = wordLike('dnet');
const PNL_RE = wordLike('pnl');
const HFR_RE = wordLike('hfr');
/** "cr memo" or "credit memo" — checked ahead of the "Inv..." rule since a
 *  credit memo's filename is often itself invoice-prefixed (e.g. "Inv Credit
 *  Memo 12345.pdf"), which would otherwise misclassify it as 'invoice'. */
const CREDIT_MEMO_RE = /\b(?:cr|credit)\s*memo\b/i;

/**
 * Classify a file by name (and, optionally, its immediate containing folder)
 * — checked in this order, first match wins:
 *    1. contains "cr memo" or "credit memo"                -> credit_memo
 *    2. starts with "POD"                                  -> proof_of_delivery
 *    3. starts with "Inv"                                  -> invoice
 *    4. contains "bom" as a standalone token                -> build_of_materials
 *    5. contains "dnet" as a standalone token                -> quote
 *    6. contains "pnl" as a standalone token                -> load_schedule
 *    7. contains "hfr" as a standalone token                -> order
 *    8. leaf folder name contains "shipping images"        -> shipping_images
 *    9. contains "change order"                            -> change_order
 *   10. contains "quote"                                   -> quote
 *   11. contains "rma" as a standalone token                -> rma
 *   12. contains "waiver"                                  -> waiver
 *   13. contains "panelboard schedule(s)"                  -> panelboard_schedules
 *   14. contains "load schedule", "meter(s)", or "programming" -> load_schedule
 *   15. contains "email", or ends in ".msg"                -> email
 *   16. contains "packing slip"                            -> packing_slip
 *   17. starts with "PO", or contains "purchase order"     -> order
 *   18. otherwise                                          -> other
 *
 * Callers that have no PO/order context to layer a further rule on top
 * (e.g. DocumentsGrid's drag-and-drop) should treat a remaining 'other'
 * result on an image file as 'shipping_images' — see isImageFile(). Callers
 * that DO have PO context (DocumentImportPanel) check that first instead,
 * matching the original priority order.
 */
export function classifyDocType(fileName: string, leafFolder = ''): DocType {
  if (CREDIT_MEMO_RE.test(fileName)) return 'credit_memo';
  if (/^pod/i.test(fileName)) return 'proof_of_delivery';
  if (/^inv/i.test(fileName)) return 'invoice';
  if (BOM_RE.test(fileName)) return 'build_of_materials';
  if (DNET_RE.test(fileName)) return 'quote';
  if (PNL_RE.test(fileName)) return 'load_schedule';
  if (HFR_RE.test(fileName)) return 'order';
  if (/shipping\s*images?/i.test(leafFolder)) return 'shipping_images';
  if (/change\s*order/i.test(fileName)) return 'change_order';
  if (/quote/i.test(fileName)) return 'quote';
  if (RMA_RE.test(fileName)) return 'rma';
  if (/waiver/i.test(fileName)) return 'waiver';
  if (/panelboard\s*schedules?/i.test(fileName)) return 'panelboard_schedules';
  if (/load\s*schedule/i.test(fileName) || METER_RE.test(fileName) || /programming/i.test(fileName)) return 'load_schedule';
  if (/email/i.test(fileName) || /\.msg$/i.test(fileName)) return 'email';
  if (/packing\s*slip/i.test(fileName)) return 'packing_slip';
  if (/^po/i.test(fileName) || /purchase\s*order/i.test(fileName)) return 'order';
  return 'other';
}

/**
 * classifyDocType() wired for a browser File — used to feed DocumentsGrid's
 * classifyDocType prop directly (its drag-and-drop and "Add Folder" have no
 * PO context, so this is the shared rules plus the image fallback only).
 * webkitRelativePath (set when the file came from a folder picker) supplies
 * the leaf-folder context for the "shipping images" folder rule; a plain
 * drag-and-dropped file has none, which the base rules already handle.
 */
export function classifyDocTypeForFile(file: File): DocType {
  const parts = (file.webkitRelativePath || '').split('/');
  const leafFolder = parts.length > 1 ? parts[parts.length - 2] : '';
  const base = classifyDocType(file.name, leafFolder);
  return base === 'other' && isImageFile(file.name) ? 'shipping_images' : base;
}
