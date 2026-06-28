import React, { useState, useRef } from "react";
import { FileUp, Receipt, Check, Loader2, AlertCircle, ShoppingBag, UserCheck, Plus, Sparkles, RefreshCw, Edit2, Gift, BadgePercent, Clock, GripVertical, X, FilePlus2, Files } from "lucide-react";
import { collection, doc, setDoc, updateDoc, serverTimestamp, query, where, getDocs, limit, or } from "firebase/firestore";
import { db, handleFirestoreError, OperationType } from "../firebase";
import { Rep, Invoice, InvoiceItem } from "../types";
import { motion } from "motion/react";

interface DocketScannerProps {
  reps: Rep[];
  products: never[];
  onScanConfirmed: () => void;
  currentUserUid: string;
}

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

// NZ GST rate. Used only to NORMALIZE an inc-GST printed price back down to
// the ex-GST figure this app stores everywhere (PriceEntry.unitPrice /
// PriceEntry.price are always ex-GST — ProductCatalog and RepDirectory both
// multiply by 1.15 themselves when displaying "inc. GST" figures). Without
// this normalization, a docket that already prints inc-GST prices would get
// GST applied a second time downstream.
const GST_RATE = 0.15;

// Now on the PAID tier (billing linked) — per-minute rate limits are much
// higher than free tier, so the aggressive staggering/delays used while on
// free tier are mostly unnecessary now. Retries are kept as a safety net
// for genuine transient issues (an occasional spend-based 429, or a
// Google-side 503 overload) rather than as the primary defense — those
// should now be rare edge cases, not a constant background concern.
const MAX_GEMINI_RETRIES = 3;
const RETRY_DELAY_MS = [2000, 5000, 10000]; // backoff: 2s, 5s, 10s

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const callGemini = async (prompt: string, imagePart?: { mime_type: string; data: string }, attempt: number = 0): Promise<string> => {
  const parts: any[] = [];
  if (imagePart) parts.push({ inline_data: imagePart });
  parts.push({ text: prompt });

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0 }
      })
    }
  );

  if (!response.ok) {
    if ((response.status === 429 || response.status === 503) && attempt < MAX_GEMINI_RETRIES) {
      await sleep(RETRY_DELAY_MS[attempt]);
      return callGemini(prompt, imagePart, attempt + 1);
    }
    const err = await response.json().catch(() => null);
    if (response.status === 429) {
      throw new Error("RATE_LIMITED");
    }
    throw new Error(err?.error?.message || "Gemini API call failed");
  }

  const data = await response.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return raw.replace(/```json|```/g, "").trim();
};

// Strips common business-entity suffixes/connectors so that names like
// "Pacific Impex Ltd" and "Pacific Impex Wholesalers & Distributors" both
// reduce to a comparable "core" string ("pacific impex"). This prevents the
// same supplier appearing on different dockets from creating duplicate rep
// profiles just because the printed company name varies slightly.
const normalizeCompanyName = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[&]/g, " and ")
    .replace(/\b(ltd|limited|inc|incorporated|llc|pty|co|company)\b/g, "")
    .replace(/\b(wholesalers?|distributors?|trading|imports?|exports?|nz|new zealand)\b/g, "")
    .replace(/\b(and|of|the)\b/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

// Splits a product name into "significant" words for overlap comparison —
// drops short filler words (under 3 chars) and pure numbers/sizes (500ML,
// 12, etc.) since those don't reliably distinguish one product from
// another on their own and would inflate false-positive overlap scores.
const significantWords = (name: string): string[] => {
  return name
    .toUpperCase()
    .split(/[\s,/.\-()]+/)
    .filter(w => w.length >= 3)
    .filter(w => !/^\d+(ML|G|KG|L|GM|MG)?$/.test(w)); // drop pure sizes like 500ML, 375, 130G
};

// Extracts size/volume/weight tokens specifically (500ML, 330ML, 1KG, 250G,
// etc.) — these are deliberately EXCLUDED from significantWords() above
// because they'd inflate false-positive overlap scores, but that means
// significantWords() alone can't tell "MUSASHI MANGO 500ML" apart from
// "MUSASHI MANGO 330ML" — both score high word overlap despite being
// different products with different prices. This function exists purely
// to catch that specific blind spot.
const sizeTokens = (name: string): string[] => {
  const matches = name.toUpperCase().match(/\d+(\.\d+)?\s*(ML|G|KG|L|GM|MG)\b/g) || [];
  return matches.map(m => m.replace(/\s+/g, ""));
};

// THE SAFETY NET. Gemini's batch matching occasionally misaligns which
// docket line a matchedId belongs to, especially on long dockets with many
// similarly-named products (e.g. "Chocolate Mystery Cruncher" and
// "Raspberry Bar" sitting near each other in both the docket and the
// candidate list) — this caused real cross-contamination between unrelated
// products' price history. This check is a deterministic, code-level
// verification that runs AFTER every Gemini match, regardless of what
// confidence Gemini claims. If the candidate's actual stored name doesn't
// share enough real word overlap with the docket line's name, OR the two
// names disagree on size/volume, the match is rejected outright — it's
// treated as unmatched (safe: creates a new product or flags for manual
// review) rather than silently saving a price against the wrong product
// (unsafe: corrupts two products' history).
//
// Threshold raised from 0.5 -> 0.65 and a dedicated size-mismatch check
// added after switching BATCH_SIZE from 8 -> 10: slightly larger batches
// mean slightly more chance of two similar products sharing a batch, so
// this net needed to be a bit stricter to compensate. The size check in
// particular closes a real gap — two products that are identical except
// for size/volume (e.g. different pack sizes of the same flavour) would
// previously pass word-overlap easily despite being genuinely different
// products with different real-world prices.
const isMatchVerified = (docketName: string, candidateName: string): boolean => {
  const docketWords = significantWords(docketName);
  if (docketWords.length === 0) return true; // nothing meaningful to check against, don't block

  const candidateWords = new Set(significantWords(candidateName));
  const overlapCount = docketWords.filter(w => candidateWords.has(w)).length;
  const overlapRatio = overlapCount / docketWords.length;

  if (overlapRatio < 0.65) return false;

  // Size/volume guard: if BOTH names contain a size token and those tokens
  // don't match, reject regardless of how high the word overlap is. This
  // is what stops "MANGO 500ML" from being matched against "MANGO 330ML"
  // just because every other word lines up.
  const docketSizes = sizeTokens(docketName);
  const candidateSizes = sizeTokens(candidateName);
  if (docketSizes.length > 0 && candidateSizes.length > 0) {
    const sizesAgree = docketSizes.some(s => candidateSizes.includes(s));
    if (!sizesAgree) return false;
  }

  return true;
};

// Given one batch of docket items, returns ONLY the candidates that could
// plausibly match something in THIS batch — instead of the full
// across-the-whole-docket candidate list. Previously every batch embedded
// every candidate gathered from every item on the entire docket as input
// text, which meant a 20-item docket split into 3 batches would resend a
// large shared candidate list 3 times over, ballooning input tokens (and
// therefore cost) for no benefit — a batch of items can only ever match
// against candidates sharing a brand-word with THOSE items, never the
// others. Narrowing this is a pure cost reduction with no change in
// matching behavior.
const getRelevantCandidatesForBatch = (
  batchItems: { item: any }[],
  allCandidates: { id: string; name: string; sku: string }[]
): { id: string; name: string; sku: string }[] => {
  const batchFirstWords = new Set<string>();
  const batchCodes = new Set<string>();
  batchItems.forEach(({ item }) => {
    const nameUpper = (item.name || "").toUpperCase();
    const firstWord = nameUpper.split(" ")[0];
    if (firstWord && firstWord.length > 2) batchFirstWords.add(firstWord);
    if (item.code && item.code !== "null") batchCodes.add(item.code);
  });

  return allCandidates.filter(c => {
    const nameUpper = c.name.toUpperCase();
    const matchesWord = Array.from(batchFirstWords).some(w => nameUpper.startsWith(w));
    const matchesCode = c.sku && batchCodes.has(c.sku);
    return matchesWord || matchesCode;
  });
};

// Strips all non-digit characters so phone numbers compare reliably
// regardless of formatting differences between scans (spaces, dashes,
// brackets, leading "0" vs "+64", etc.) — e.g. "09 274 3030" and
// "(09) 2743030" both normalize to "0927743030".
const normalizePhone = (phone: string | null | undefined): string => {
  if (!phone) return "";
  return phone.replace(/[^0-9]/g, "");
};

// One file selected for this scan, plus a stable key so the reorder UI
// (drag-and-drop) can track identity across re-renders even though File
// objects themselves don't carry a natural id.
interface PendingFile {
  key: string;
  file: File;
}

// Raw OCR result from a single page, before merging. Kept separate per
// page so the merge step can reason about "which page had this field"
// rather than working from an already-flattened blob.
interface PageOcrResult {
  pageIndex: number;
  supplierName: string;
  repName: string | null;
  repPhone: string | null;
  repEmail: string | null;
  invoiceDate: string | null;
  totalAmount: number;
  items: any[];
}

export default function DocketScanner({ reps, onScanConfirmed, currentUserUid }: DocketScannerProps) {
  const [dragActive, setDragActive] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [status, setStatus] = useState<"idle" | "scanning" | "matching" | "review" | "saving" | "success" | "error" | "cooldown">("idle");
  const [matchingProgress, setMatchingProgress] = useState("");
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  const [extractedData, setExtractedData] = useState<{
    supplierName: string;
    repName: string | null;
    repPhone: string | null;
    repEmail: string | null;
    invoiceDate: string;
    totalAmount: number;
    items: InvoiceItem[];
  } | null>(null);

  const [selectedRepId, setSelectedRepId] = useState<string>("");
  const [invoiceRecordId, setInvoiceRecordId] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState("");

  // Drag-reorder state for the pending-files list. dragOverKey highlights
  // the row currently being hovered during a drag so the person can see
  // where the dropped item will land before releasing.
  const draggedKeyRef = useRef<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  // Hard lock against double-firing a scan. status already prevents the
  // button from being clickable once a scan starts, but this ref is an
  // extra belt-and-suspenders guard in case of any race (e.g. a very fast
  // double-click landing both calls before the first re-render commits).
  const scanInFlightRef = useRef(false);
  const cooldownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  let fileKeyCounter = useRef(0);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.length) handleFilesSelected(Array.from(e.dataTransfer.files));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) handleFilesSelected(Array.from(e.target.files));
  };

  // Appends newly selected files to whatever's already pending — supports
  // the "Add more pages" flow where a manager scans page 1, then comes
  // back to add page 2 without losing page 1's selection.
  const handleFilesSelected = (newFiles: File[]) => {
    const validMimes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    const valid: PendingFile[] = [];
    let rejectedCount = 0;

    newFiles.forEach(f => {
      if (!validMimes.includes(f.type)) {
        rejectedCount++;
        return;
      }
      fileKeyCounter.current += 1;
      valid.push({ key: `f${fileKeyCounter.current}_${f.name}_${f.size}`, file: f });
    });

    if (valid.length > 0) {
      setPendingFiles(prev => [...prev, ...valid]);
      setStatus("idle");
    }
    if (rejectedCount > 0 && valid.length === 0) {
      setStatus("error");
      setErrorMessage("Unsupported file type. Please upload Photos (JPEG/PNG) or PDF dockets.");
    }
  };

  const handleRemoveFile = (key: string) => {
    setPendingFiles(prev => prev.filter(f => f.key !== key));
  };

  // ── DRAG-TO-REORDER ──────────────────────────────────────────────────
  // Plain HTML5 drag events — deliberately not a library, since this is a
  // short list (typically 2-5 pages) and a full drag-and-drop dependency
  // would be overkill for swapping array positions.
  const handleDragStart = (key: string) => {
    draggedKeyRef.current = key;
  };

  const handleDragOverItem = (e: React.DragEvent, key: string) => {
    e.preventDefault();
    setDragOverKey(key);
  };

  const handleDropOnItem = (e: React.DragEvent, targetKey: string) => {
    e.preventDefault();
    const sourceKey = draggedKeyRef.current;
    setDragOverKey(null);
    draggedKeyRef.current = null;
    if (!sourceKey || sourceKey === targetKey) return;

    setPendingFiles(prev => {
      const list = [...prev];
      const sourceIdx = list.findIndex(f => f.key === sourceKey);
      const targetIdx = list.findIndex(f => f.key === targetKey);
      if (sourceIdx === -1 || targetIdx === -1) return prev;
      const [moved] = list.splice(sourceIdx, 1);
      list.splice(targetIdx, 0, moved);
      return list;
    });
  };

  const convertFileToBase64 = (selectedFile: File): Promise<{ base64: string; mimeType: string }> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(selectedFile);
      reader.onload = () => {
        const result = reader.result as string;
        resolve({ base64: result.substring(result.indexOf(",") + 1), mimeType: selectedFile.type });
      };
      reader.onerror = reject;
    });

  // Finds an existing rep by PHONE or EMAIL first — these are far more
  // reliable than company name for matching across scans, because OCR can
  // introduce single-character noise into a printed name (e.g. "Ashon
  // Ventures" misread as "Ashton Ventures") that a phone number's digits
  // are immune to. Only when neither signal is available on this docket
  // does the function fall back to the original normalized-name
  // comparison, which is necessarily weaker since it has nothing else to
  // go on.
  //
  // This ordering matters: phone/email match SHORT-CIRCUITS the name
  // check entirely. If the phone matches, that's the rep — regardless of
  // what the company name says, since contact details are much less
  // likely to coincidentally collide between two genuinely different
  // suppliers than a name is to vary by a letter between two scans of the
  // SAME supplier.
  const findOrCreateRep = async (
    supplierName: string,
    repName: string | null,
    repPhone: string | null,
    repEmail: string | null
  ): Promise<string> => {
    const normalizedTarget = normalizeCompanyName(supplierName);
    const targetPhone = normalizePhone(repPhone);
    const targetEmail = repEmail?.trim().toLowerCase() || "";

    let existingRep: typeof reps[number] | undefined;
    let matchedBy: "phone" | "email" | "name" | null = null;

    // 1. Phone match — strongest signal, checked first.
    if (targetPhone) {
      existingRep = reps.find(r => normalizePhone(r.phone) === targetPhone && normalizePhone(r.phone) !== "");
      if (existingRep) matchedBy = "phone";
    }

    // 2. Email match — equally strong, checked if phone didn't match.
    if (!existingRep && targetEmail) {
      existingRep = reps.find(r => (r.email?.trim().toLowerCase() || "") === targetEmail && targetEmail !== "");
      if (existingRep) matchedBy = "email";
    }

    // 3. Fallback to normalized company-name comparison — only reached
    // when this docket has no phone or email to compare against at all.
    if (!existingRep) {
      existingRep = reps.find(r => {
        const normalizedExisting = normalizeCompanyName(r.company);
        if (!normalizedExisting || !normalizedTarget) return false;
        return (
          normalizedExisting === normalizedTarget ||
          normalizedExisting.includes(normalizedTarget) ||
          normalizedTarget.includes(normalizedExisting)
        );
      });
      if (existingRep) matchedBy = "name";
    }

    if (existingRep) {
      const patch: { phone?: string; email?: string; company?: string } = {};
      if (!existingRep.phone && repPhone) patch.phone = repPhone;
      if (!existingRep.email && repEmail) patch.email = repEmail;

      // Only correct the stored company name when the match came from
      // phone or email (a confident match), AND the new OCR'd name at
      // least loosely resembles the existing one — this lets a one-letter
      // OCR slip ("Ashon" -> "Ashton") get corrected back, while refusing
      // to let one badly garbled scan overwrite a good name with
      // something unrecognizable. A name-based match never triggers a
      // rename here, since the name was already the thing being matched
      // on — there's nothing new to correct.
      if (
        (matchedBy === "phone" || matchedBy === "email") &&
        supplierName.trim() &&
        existingRep.company !== supplierName.trim()
      ) {
        const normalizedExisting = normalizeCompanyName(existingRep.company);
        const looselyResembles =
          normalizedExisting === normalizedTarget ||
          normalizedExisting.includes(normalizedTarget) ||
          normalizedTarget.includes(normalizedExisting) ||
          (normalizedTarget.length > 3 &&
            normalizedExisting.length > 3 &&
            (normalizedTarget.includes(normalizedExisting.slice(0, -2)) ||
              normalizedExisting.includes(normalizedTarget.slice(0, -2))));

        if (looselyResembles) {
          patch.company = supplierName.trim();
        } else {
          console.warn(
            `Matched rep by ${matchedBy}, but new supplier name "${supplierName}" doesn't loosely resemble stored name "${existingRep.company}" — keeping stored name, not auto-correcting.`
          );
        }
      }

      if (Object.keys(patch).length > 0) {
        try {
          await updateDoc(doc(db, "reps", existingRep.id), patch);
        } catch (err) {
          console.warn("Could not patch rep info:", err);
        }
      }
      return existingRep.id;
    }

    const repRef = doc(collection(db, "reps"));
    const newRepPayload: any = {
      id: repRef.id,
      name: repName || supplierName,
      company: supplierName,
      createdAt: serverTimestamp()
    };
    if (repPhone) newRepPayload.phone = repPhone;
    if (repEmail) newRepPayload.email = repEmail;

    await setDoc(repRef, newRepPayload);
    return repRef.id;
  };

  // Starts a visible countdown after a genuine rate-limit exhaustion (all
  // internal retries failed). During this window the scan/retry buttons
  // are disabled — not just discouraged via a message — so a staff member
  // physically cannot mash the button into another rate-limit hit. Once
  // the countdown reaches zero, status returns to "error" so they can
  // retry normally (which will go through its own internal retry logic
  // again if needed).
  const startCooldown = (seconds: number) => {
    setStatus("cooldown");
    setCooldownSeconds(seconds);
    if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current);
    cooldownIntervalRef.current = setInterval(() => {
      setCooldownSeconds(prev => {
        if (prev <= 1) {
          if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current);
          setStatus("error");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  // Runs OCR on a single page and returns its raw (un-merged) result.
  const ocrSinglePage = async (file: File, pageIndex: number): Promise<PageOcrResult> => {
    const { base64, mimeType } = await convertFileToBase64(file);

    const ocrPrompt = `You are an expert invoice analyzer for a New Zealand supermarket.
Analyze this supplier docket/invoice carefully. This may be ONE PAGE of a MULTI-PAGE invoice — if this page has no visible supplier letterhead, contact details, or invoice header (e.g. it's purely a continuation table of line items), that is normal and expected. In that case, return null/empty for the header fields below and still extract every line item visible on this page.

Extract and return ONLY a valid JSON object with no markdown, no explanation:
{
  "supplierName": "full company name on the docket, or null if not visible on this page",
  "repName": "sales rep name if visible, otherwise null",
  "repPhone": "sales rep or supplier contact phone number if visible anywhere on the docket (e.g. near a contact name, 'Ph:', 'Mob:', 'Tel:'), otherwise null",
  "repEmail": "sales rep or supplier contact email address if visible anywhere on the docket, otherwise null",
  "invoiceDate": "date in YYYY-MM-DD format, or null if not visible on this page",
  "totalAmount": total invoice amount as number if visible on THIS page (e.g. a 'Total NZD' or grand total line), or 0 if this page only shows a subtotal or no total at all,
  "items": [
    {
      "name": "full expanded standardised product name in UPPERCASE English",
      "code": "supplier product code if visible, otherwise null",
      "quantity": quantity ordered as whole number (number of cases/cartons, NOT individual units),
      "unitPrice": the PRE-DISCOUNT box/case price exactly as printed in the docket's "Price" or "Unit Price" column for this line, as a decimal number. Do NOT apply any discount to this number, and do NOT adjust it for GST yourself — extract it exactly as printed, character for character converted to a number,
      "discPercent": the discount percentage exactly as printed in the docket's "Disc%" or "Disc." column for this line, as a plain number (e.g. 13 for "13%", 100 for "100%", 0 if no discount column or blank/0% shown for this line),
      "packQuantity": the number of individual units inside one case/carton/box for this line, as a whole number,
      "gstStatus": "inclusive" if the column header or nearby label for this price explicitly says it includes GST (e.g. "Unit Price (inc-GST)", "Price incl. GST", "Inc GST"), "exclusive" if explicitly labelled as excluding GST (e.g. "Price (excl GST)", "ex-GST", "+GST" shown separately as an addition), or if there is no GST label at all anywhere on the docket near this price column (most NZ wholesale dockets quote ex-GST by default with GST added as a separate total line), "unknown" only if the docket is genuinely ambiguous or contradictory about GST treatment for this column
    }
  ]
}

Critical rules:
- ALL product names in UPPERCASE
- Expand ALL abbreviations: Msshi→MUSASHI, Shrd→SHREDDED, Enrgy→ENERGY, Rasp→RASPBERRY, Lm→LEMON, P/Fruit→PASSIONFRUIT, Choc→CHOCOLATE, Straw→STRAWBERRY, Van→VANILLA, B/B→BIG BANG
- Include: Brand + Product Type + Size/Volume + Flavour
- Remove pack multipliers (x12, X24, *12, 12pk, per carton, x10/pack) from the NAME field only — but capture that exact number in "packQuantity" instead of discarding it. These multipliers can appear anywhere in the description, with x, X, or * as the separator, in brackets or not, in any position (e.g. "DRAGON COOL BANANA SPRAY (9)" → packQuantity 9, "MUSASHI ENERGY MANGO 500ML 12PK" → packQuantity 12, "KOBI SALTED PEANUTS 130GX24CTN" → packQuantity 24)
- If no pack size number is visible anywhere for a line (e.g. loose produce, single units), set "packQuantity" to 1
- Keep product size like 375ML, 500ML, 130G, 43G, 26G in the name — this is CRITICAL for distinguishing between different pack sizes of the same product, which have different prices
- "unitPrice" must be the PRE-discount box/case price column exactly as printed — never the final/extended/total/amount column, and never with any discount already applied. Return the RAW printed number regardless of gstStatus — GST adjustment is handled separately, do not do it yourself
- "gstStatus" is determined by reading the actual column headers / labels on THIS docket, not by assumption — look for words like "inc-GST", "incl GST", "GST inclusive" (→ "inclusive") vs "excl GST", "ex-GST", "+GST" (→ "exclusive"). If you see no such label anywhere near the price columns, use "exclusive" (the NZ wholesale default), not "unknown". Only use "unknown" if there are conflicting or unreadable labels
- "discPercent" must be the discount percentage column exactly as printed, as a plain number with no % sign (e.g. write 24, not "24%"). If the docket has no discount column at all, or shows 0% for this line, use 0
- quantity = QTY column value as integer (number of cases/cartons ordered, not units inside)
- repPhone and repEmail can belong to a named contact person on the docket even if that person is not explicitly labelled "rep" — use your judgement based on context (e.g. a name with a phone number and/or email near the supplier letterhead). If multiple contacts are listed, prefer the one matching repName, otherwise the first one listed
- Return only JSON, nothing else`;

    const ocrRaw = await callGemini(ocrPrompt, { mime_type: mimeType, data: base64 });
    const payload = JSON.parse(ocrRaw);

    return {
      pageIndex,
      supplierName: payload.supplierName || "",
      repName: payload.repName || null,
      repPhone: payload.repPhone || null,
      repEmail: payload.repEmail || null,
      invoiceDate: payload.invoiceDate || null,
      totalAmount: typeof payload.totalAmount === "number" ? payload.totalAmount : (parseFloat(payload.totalAmount) || 0),
      items: payload.items || []
    };
  };

  // Merges per-page OCR results into one combined invoice, in page order
  // (the order set by the reorder UI before scanning started).
  //
  // Header fields (supplier/rep/phone/email/date): FIRST non-empty value
  // across pages wins. totalAmount takes the LARGEST non-zero value found
  // across all pages (handles grand-total-on-last-page layouts correctly).
  // items: concatenated across all pages in order.
  const mergeOcrPayloads = (pageResults: PageOcrResult[]) => {
    const firstNonEmpty = (getter: (p: PageOcrResult) => string | null): string | null => {
      for (const p of pageResults) {
        const val = getter(p);
        if (val && val.trim()) return val.trim();
      }
      return null;
    };

    const supplierName = firstNonEmpty(p => p.supplierName) || "Unknown Supplier";
    const repName = firstNonEmpty(p => p.repName);
    const repPhone = firstNonEmpty(p => p.repPhone);
    const repEmail = firstNonEmpty(p => p.repEmail);
    const invoiceDate = firstNonEmpty(p => p.invoiceDate) || new Date().toISOString().split("T")[0];
    const totalAmount = Math.max(0, ...pageResults.map(p => p.totalAmount || 0));

    const items = pageResults.flatMap(p =>
      p.items.map((item: any) => ({ ...item, sourcePage: p.pageIndex + 1 }))
    );

    return { supplierName, repName, repPhone, repEmail, invoiceDate, totalAmount, items };
  };

  const handleStartOCRScan = async () => {
    if (scanInFlightRef.current) return;
    if (pendingFiles.length === 0) { setStatus("error"); setErrorMessage("Please select at least one file to scan."); return; }
    if (!GEMINI_API_KEY) { setStatus("error"); setErrorMessage("Gemini API key not found. Add VITE_GEMINI_API_KEY to your .env file."); return; }

    scanInFlightRef.current = true;
    setStatus("scanning");
    try {
      // ── STEP 1: OCR every page ───────────────────────────────────────────
      // Now on paid tier — pages can run in small concurrent pairs again
      // rather than fully sequential, since the per-minute ceiling that
      // forced strict sequencing on free tier is no longer the binding
      // constraint. A short delay between chunks is kept as cheap
      // insurance, not because it's required at this volume.
      const OCR_CHUNK_SIZE = 2;
      const OCR_CHUNK_DELAY_MS = 500;
      const pageResults: PageOcrResult[] = [];
      for (let i = 0; i < pendingFiles.length; i += OCR_CHUNK_SIZE) {
        const chunk = pendingFiles.slice(i, i + OCR_CHUNK_SIZE);
        const chunkResults = await Promise.all(
          chunk.map((pf, j) => ocrSinglePage(pf.file, i + j))
        );
        pageResults.push(...chunkResults);
        if (i + OCR_CHUNK_SIZE < pendingFiles.length) {
          await sleep(OCR_CHUNK_DELAY_MS);
        }
      }

      // ── STEP 1.25: MERGE pages into one combined invoice ────────────────
      const merged = mergeOcrPayloads(pageResults);

      // ── STEP 1.5: GST NORMALIZATION — deterministic, code-level ────────
      // This app stores PriceEntry.unitPrice / PriceEntry.price as EX-GST
      // everywhere — ProductCatalog.tsx and RepDirectory.tsx both multiply
      // by 1.15 themselves to show "inc. GST" figures. The actual ÷1.15
      // division happens here in plain arithmetic — not inside the LLM
      // prompt — so it's deterministic and auditable rather than trusting
      // Gemini's mental maths.
      const rawItems: any[] = merged.items || [];
      const items: any[] = rawItems.map((item: any) => {
        const parsedRaw = typeof item.unitPrice === "number" ? item.unitPrice : parseFloat(item.unitPrice);
        const rawUnitPrice = !isNaN(parsedRaw) ? parsedRaw : 0;
        const gstStatus = item.gstStatus === "inclusive" ? "inclusive" : item.gstStatus === "unknown" ? "unknown" : "exclusive";

        if (gstStatus === "inclusive" && rawUnitPrice > 0) {
          const exGstUnitPrice = Math.round((rawUnitPrice / (1 + GST_RATE)) * 100) / 100;
          return {
            ...item,
            unitPrice: exGstUnitPrice,
            gstStatus,
            originalUnitPriceIncGst: rawUnitPrice
          };
        }

        return { ...item, unitPrice: rawUnitPrice, gstStatus };
      });

      // ── STEP 2: SMART MATCHING — minimal Firestore reads ───────────────
      setStatus("matching");
      setMatchingProgress("Collecting unique search terms...");

      const firstWords = new Set<string>();
      const codes = new Set<string>();

      items.forEach((item: any) => {
        const nameUpper = (item.name || "").toUpperCase();
        const firstWord = nameUpper.split(" ")[0];
        if (firstWord && firstWord.length > 2) firstWords.add(firstWord);
        if (item.code && item.code !== "null") codes.add(item.code);
      });

      setMatchingProgress(`Searching database for ${firstWords.size} unique brands...`);

      const candidateMap: Map<string, { id: string; name: string; sku: string }> = new Map();

      const wordQueries = Array.from(firstWords).map(word =>
        getDocs(query(
          collection(db, "products"),
          where("name", ">=", word),
          where("name", "<=", word + "\uf8ff"),
          limit(15)
        ))
      );

      const codeQueries = Array.from(codes).map(code =>
        getDocs(query(
          collection(db, "products"),
          where("sku", "==", code),
          limit(1)
        ))
      );

      const [wordResults, codeResults] = await Promise.all([
        Promise.all(wordQueries),
        Promise.all(codeQueries)
      ]);

      [...wordResults, ...codeResults].forEach(snap => {
        snap.docs.forEach(d => {
          candidateMap.set(d.id, {
            id: d.id,
            name: d.data().name || "",
            sku: d.data().sku || ""
          });
        });
      });

      const allCandidates = Array.from(candidateMap.values());

      // ── STEP 3: BATCHED Gemini matching ─────────────────────────────────
      // BATCH_SIZE raised from 8 -> 10. This is a deliberate middle ground:
      // larger batches mean fewer total Gemini calls (lower cost, since
      // every call repeats shared prompt boilerplate), but too large
      // reintroduces the index-misalignment risk this batching was built
      // to prevent in the first place. 10 was chosen over a more
      // cost-aggressive 14-16 specifically because matching accuracy is
      // the higher priority here — the isMatchVerified() safety net below
      // was also tightened (0.5 -> 0.65 overlap threshold, plus a new
      // size/volume mismatch check) to compensate for the larger batch.
      const BATCH_SIZE = 10;
      const batches: { item: any; originalIndex: number }[][] = [];
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        batches.push(
          items.slice(i, i + BATCH_SIZE).map((item, j) => ({ item, originalIndex: i + j }))
        );
      }

      setMatchingProgress(`Matching ${items.length} products in ${batches.length} batch${batches.length > 1 ? "es" : ""} of up to ${BATCH_SIZE}...`);

      // Stagger reduced from 2500ms -> 400ms now that paid-tier RPM is the
      // constraint, not free-tier. Batches still don't all fire in the
      // exact same instant, but the gap no longer needs to be large.
      const MATCH_BATCH_STAGGER_MS = 400;
      const batchPromises = batches.map(async (batch, batchIdx) => {
        if (batchIdx > 0) {
          await sleep(batchIdx * MATCH_BATCH_STAGGER_MS);
        }

        const relevantCandidates = getRelevantCandidatesForBatch(batch, allCandidates);

        const matchPrompt = `You are a product matching assistant for a New Zealand supermarket.

Match each docket product to the best database candidate IN MEMORY — no more database calls needed.

Docket products to match:
${batch.map((b, i) => `${i + 1}. "${b.item.name}" (code: ${b.item.code || "none"})`).join("\n")}

Database candidates available:
${relevantCandidates.map(c => `- ID: ${c.id} | Name: ${c.name} | SKU: ${c.sku}`).join("\n")}

Matching rules:
- Match by brand + product type + size/volume + flavour
- Word order differences are OK (MUSASHI ENERGY MANGO 500ML = MUSASHI 500ML MANGO)
- Size/volume MUST match exactly — 500ML and 330ML are DIFFERENT products with different prices, even if every other word matches. Never treat different sizes of the same flavour as interchangeable.
- Flavour must match (MANGO ≠ PINEAPPLE)
- If supplier code matches SKU exactly — that is a definitive match
- If no reasonable match exists — use null
- Do NOT force a wrong match
- Be especially careful not to confuse different products that happen to be listed near each other, or different sizes of the same product — verify the brand AND product type AND size all genuinely match before accepting

Return ONLY a JSON array, no markdown:
[
  {"productIndex": 1, "matchedId": "barcode_id_or_null", "confidence": "high/medium/low/none"},
  {"productIndex": 2, "matchedId": "barcode_id_or_null", "confidence": "high/medium/low/none"}
]`;

        const matchRaw = await callGemini(matchPrompt);
        let batchResults: { productIndex: number; matchedId: string | null; confidence: string }[] = [];
        try {
          batchResults = JSON.parse(matchRaw);
        } catch {
          console.error("Match parse error for batch:", matchRaw);
          batchResults = [];
        }

        return batchResults.map(r => ({
          originalIndex: batch[r.productIndex - 1]?.originalIndex,
          matchedId: r.matchedId,
          confidence: r.confidence
        })).filter(r => r.originalIndex !== undefined);
      });

      const allBatchResults = (await Promise.all(batchPromises)).flat();
      const matchResultsByIndex = new Map(allBatchResults.map(r => [r.originalIndex, r]));

      // Build final items — only accept high/medium confidence matches
      // that ALSO pass the deterministic word-overlap + size verification
      // below. Box price is computed here, deterministically, from two
      // numbers — the (already GST-normalized) unitPrice and discPercent
      // — no LLM reasoning happens in this calculation, only plain
      // arithmetic: boxPrice = unitPrice × (1 − discPercent / 100)
      let rejectedMatchCount = 0;
      const matchedItems: InvoiceItem[] = items.map((item: any, index: number) => {
        const match = matchResultsByIndex.get(index);
        const llmAcceptedMatch = !!match?.matchedId && match.confidence !== "low" && match.confidence !== "none";
        const candidate = llmAcceptedMatch ? candidateMap.get(match!.matchedId!) : null;

        const verified = candidate ? isMatchVerified(item.name || "", candidate.name) : false;
        const acceptMatch = llmAcceptedMatch && verified;

        if (llmAcceptedMatch && !verified) {
          rejectedMatchCount++;
          console.warn(
            `Match rejected by verification: docket item "${item.name}" was matched to candidate "${candidate?.name}" (${match?.matchedId}) but failed word-overlap or size check. Treating as unmatched.`
          );
        }

        const rawUnitPrice = typeof item.unitPrice === "number" ? item.unitPrice : parseFloat(item.unitPrice);
        const unitPrice = !isNaN(rawUnitPrice) ? rawUnitPrice : 0;

        const rawDiscPercent = typeof item.discPercent === "number" ? item.discPercent : parseFloat(item.discPercent);
        const discPercent = !isNaN(rawDiscPercent) ? Math.max(0, Math.min(100, rawDiscPercent)) : 0;

        const boxPrice = unitPrice * (1 - discPercent / 100);

        const rawQty = parseInt(item.quantity);
        const quantity = !isNaN(rawQty) && rawQty > 0 ? rawQty : 1;

        const rawPackQty = parseInt(item.packQuantity);
        const packQuantity = !isNaN(rawPackQty) && rawPackQty > 0 ? rawPackQty : 1;

        return {
          name: item.name,
          code: item.code || null,
          quantity,
          price: Math.round(boxPrice * 100) / 100,
          packQuantity,
          unitPrice,
          discPercent,
          gstStatus: item.gstStatus || "exclusive",
          originalUnitPriceIncGst: item.originalUnitPriceIncGst ?? null,
          sourcePage: item.sourcePage ?? null,
          matchedProductId: acceptMatch ? match!.matchedId! : "",
          matchedProductName: acceptMatch ? (candidate?.name || "") : ""
        } as any;
      });

      if (rejectedMatchCount > 0) {
        setMatchingProgress(`${rejectedMatchCount} match${rejectedMatchCount > 1 ? "es" : ""} rejected by verification — review these manually.`);
      }

      // ── STEP 4: Find or create rep ─────────────────────────────────────
      const repId = await findOrCreateRep(
        merged.supplierName,
        merged.repName,
        merged.repPhone,
        merged.repEmail
      );
      setSelectedRepId(repId);

      setExtractedData({
        supplierName: merged.supplierName,
        repName: merged.repName,
        repPhone: merged.repPhone,
        repEmail: merged.repEmail,
        invoiceDate: merged.invoiceDate,
        totalAmount: merged.totalAmount,
        items: matchedItems
      });

      const invoiceRef = doc(collection(db, "invoices"));
      await setDoc(invoiceRef, {
        id: invoiceRef.id,
        fileUrl: "frontend-upload",
        fileName: pendingFiles.map(pf => pf.file.name).join(", "),
        repId,
        repName: merged.repName || merged.supplierName,
        invoiceDate: merged.invoiceDate,
        totalAmount: merged.totalAmount,
        status: "pending_review",
        items: matchedItems,
        createdAt: serverTimestamp(),
        createdBy: currentUserUid
      } as Invoice);
      setInvoiceRecordId(invoiceRef.id);
      setStatus("review");

    } catch (err: any) {
      console.error("Scanning failed:", err);
      if (err.message === "RATE_LIMITED") {
        setErrorMessage("Gemini is temporarily busy. The app will let you retry automatically in a moment — please don't refresh.");
        startCooldown(30);
      } else {
        setStatus("error");
        setErrorMessage(err.message || "Failed to scan docket. Check your Gemini API key.");
      }
    } finally {
      scanInFlightRef.current = false;
    }
  };

  const handleUpdateItemField = (index: number, field: keyof InvoiceItem, value: any) => {
    if (!extractedData) return;
    const itemsCopy = [...extractedData.items];
    itemsCopy[index] = { ...itemsCopy[index], [field]: value };

    if (field === ("unitPrice" as any) || field === ("discPercent" as any)) {
      const up = field === ("unitPrice" as any) ? value : (itemsCopy[index] as any).unitPrice;
      const dp = field === ("discPercent" as any) ? value : (itemsCopy[index] as any).discPercent;
      const recomputed = (up || 0) * (1 - (dp || 0) / 100);
      itemsCopy[index] = { ...itemsCopy[index], price: Math.round(recomputed * 100) / 100 };
    }

    setExtractedData({ ...extractedData, items: itemsCopy });
  };

  const handleCreateNewProduct = async (index: number) => {
    if (!extractedData) return;
    const item = extractedData.items[index];
    const newId = `DOCKET_${Math.floor(Date.now() / 1000)}_${index}`;
    try {
      await setDoc(doc(db, "products", newId), {
        id: newId,
        name: item.name.toUpperCase(),
        sku: item.code || newId,
        category: "Docket Extracted",
        lowStock: false,
        preferredRepId: selectedRepId || null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      handleUpdateItemField(index, "matchedProductId", newId);
      handleUpdateItemField(index, "matchedProductName" as any, item.name.toUpperCase());
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `products/${newId}`);
    }
  };

  const handleConfirmReviewSubmit = async () => {
    if (!extractedData || !invoiceRecordId) return;
    if (!selectedRepId) {
      setStatus("error");
      setErrorMessage("Please select a Supplier Representative before confirming.");
      return;
    }

    setStatus("saving");
    try {
      for (const item of extractedData.items) {
        let productId = item.matchedProductId;

        if (!productId) {
          const autoId = `AUTO_${Math.floor(Date.now() / 1000)}_${Math.random().toString(36).substr(2, 4)}`;
          await setDoc(doc(db, "products", autoId), {
            id: autoId,
            name: item.name.toUpperCase(),
            sku: item.code || autoId,
            category: "General",
            lowStock: false,
            preferredRepId: selectedRepId,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
          productId = autoId;
        }

        const packQty = (item as any).packQuantity && (item as any).packQuantity > 0 ? (item as any).packQuantity : 1;

        const priceRef = doc(collection(db, "prices"));
        await setDoc(priceRef, {
          id: priceRef.id,
          productId,
          repId: selectedRepId,
          price: item.price,
          packQuantity: packQty,
          unitPrice: (item as any).unitPrice ?? null,
          discPercent: (item as any).discPercent ?? 0,
          packSize: `Qty ${item.quantity} x ${packQty}/box`,
          effectiveDate: isNaN(Date.parse(extractedData.invoiceDate))
            ? serverTimestamp()
            : new Date(extractedData.invoiceDate),
          invoiceId: invoiceRecordId,
          createdAt: serverTimestamp(),
          createdBy: currentUserUid
        });
      }

      await updateDoc(doc(db, "invoices", invoiceRecordId), {
        status: "confirmed",
        repId: selectedRepId,
        invoiceDate: extractedData.invoiceDate,
        totalAmount: extractedData.totalAmount,
        items: extractedData.items
      });

      setStatus("success");
    } catch (err: any) {
      console.error("Saving failed:", err);
      setStatus("error");
      setErrorMessage(err.message || "Unable to save price history. Try again.");
    }
  };

  const matchedCount = extractedData?.items.filter(i => i.matchedProductId).length || 0;
  const totalCount = extractedData?.items.length || 0;
  const gstNormalizedCount = extractedData?.items.filter(i => (i as any).originalUnitPriceIncGst != null).length || 0;
  const pageCount = pendingFiles.length;

  return (
    <div className="bg-white rounded-md shadow-sm border border-slate-200 p-4">

      {/* HEADER */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-200">
        <div className="flex items-center gap-1.5">
          <Receipt className="h-4 w-4 text-emerald-600" />
          <h2 className="text-sm font-bold text-slate-900">Scan Wholesale Docket</h2>
        </div>
        <div className="flex items-center gap-1 px-2 py-0.5 bg-emerald-50 rounded border border-emerald-100 text-[9px] font-bold text-emerald-800">
          <Sparkles className="h-2.5 w-2.5 animate-pulse" />
          <span>Gemini 2.5 Flash — batched matching, verified</span>
        </div>
      </div>

      {/* IDLE — now supports multiple pages, reorderable */}
      {status === "idle" && (
        <div className="space-y-3">
          {pendingFiles.length === 0 ? (
            <div
              onDragEnter={handleDrag} onDragOver={handleDrag}
              onDragLeave={handleDrag} onDrop={handleDrop}
              onClick={() => document.getElementById("docket_file_picker")?.click()}
              className={`border-2 border-dashed rounded p-8 flex flex-col items-center justify-center cursor-pointer transition-all ${
                dragActive ? "border-emerald-500 bg-emerald-50/30" : "border-slate-200 hover:border-emerald-400 bg-slate-50/40"
              }`}
            >
              <FileUp className="h-8 w-8 text-slate-400 mb-2" />
              <p className="text-xs font-bold text-slate-700">Upload Wholesale Docket Photo(s) or PDF</p>
              <p className="text-[10px] text-slate-400 mt-0.5">Drag and drop or click to browse — select multiple files for a multi-page invoice</p>
              <p className="text-[9px] text-slate-400 mt-2">Accepts PDF, JPG, PNG, WEBP</p>
              <input type="file" id="docket_file_picker" className="hidden" accept="image/*,application/pdf" multiple onChange={handleFileChange} />
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-bold text-slate-600 flex items-center gap-1">
                  <Files className="h-3 w-3" />
                  <span>{pageCount} page{pageCount > 1 ? "s" : ""} selected {pageCount > 1 ? "— drag to reorder" : ""}</span>
                </p>
                <label className="text-[9px] text-emerald-700 underline font-semibold cursor-pointer flex items-center gap-1">
                  <FilePlus2 className="h-3 w-3" />
                  <span>Add more pages</span>
                  <input type="file" className="hidden" accept="image/*,application/pdf" multiple onChange={handleFileChange} />
                </label>
              </div>

              <div className="space-y-1.5">
                {pendingFiles.map((pf, idx) => (
                  <div
                    key={pf.key}
                    draggable
                    onDragStart={() => handleDragStart(pf.key)}
                    onDragOver={(e) => handleDragOverItem(e, pf.key)}
                    onDrop={(e) => handleDropOnItem(e, pf.key)}
                    onDragEnd={() => setDragOverKey(null)}
                    className={`flex items-center justify-between p-2 rounded border transition-all cursor-move ${
                      dragOverKey === pf.key ? "border-emerald-500 bg-emerald-50/50" : "border-emerald-100 bg-emerald-50/30"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <GripVertical className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      <span className="text-[9px] font-bold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded shrink-0">Page {idx + 1}</span>
                      <Receipt className="h-4 w-4 text-emerald-600 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-[11px] font-bold text-slate-800 line-clamp-1">{pf.file.name}</p>
                        <p className="text-[9px] text-slate-500">{(pf.file.size / (1024 * 1024)).toFixed(2)} MB</p>
                      </div>
                    </div>
                    <button onClick={() => handleRemoveFile(pf.key)} className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer shrink-0">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-end gap-1.5 pt-1">
                <button onClick={() => setPendingFiles([])} className="px-2 py-1 text-[10px] font-semibold text-slate-500 hover:text-slate-700 cursor-pointer">Clear All</button>
                <button onClick={handleStartOCRScan} className="px-2.5 py-1 text-[10px] font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded cursor-pointer flex items-center gap-1">
                  <Sparkles className="h-3 w-3" />
                  <span>Start Gemini Scan ({pageCount} page{pageCount > 1 ? "s" : ""})</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* SCANNING */}
      {status === "scanning" && (
        <div className="py-10 flex flex-col items-center justify-center space-y-3">
          <Loader2 className="h-8 w-8 text-emerald-600 animate-spin" />
          <div className="text-center">
            <h3 className="text-xs font-bold text-slate-800">Gemini reading {pageCount > 1 ? `${pageCount} pages` : "your docket"}...</h3>
            <p className="text-[10px] text-slate-400 mt-0.5">Extracting supplier, products, quantities and prices.</p>
            {pageCount > 1 && <p className="text-[9px] text-slate-300 mt-1">Pages scanned and merged into one invoice</p>}
          </div>
        </div>
      )}

      {/* MATCHING */}
      {status === "matching" && (
        <div className="py-10 flex flex-col items-center justify-center space-y-3">
          <Loader2 className="h-8 w-8 text-emerald-600 animate-spin" />
          <div className="text-center">
            <h3 className="text-xs font-bold text-slate-800">Matching products to database...</h3>
            <p className="text-[10px] text-slate-400 mt-0.5">{matchingProgress || "Loading candidates..."}</p>
            <p className="text-[9px] text-slate-300 mt-1">Batched matching with verification — accuracy over speed</p>
          </div>
        </div>
      )}

      {/* REVIEW */}
      {status === "review" && extractedData && (
        <div className="space-y-3 text-left">
          {pageCount > 1 && (
            <div className="flex items-center gap-2 p-2 bg-blue-50/60 border border-blue-200 rounded text-[10px] text-blue-800">
              <Files className="h-3.5 w-3.5 shrink-0" />
              <span>Merged from <strong>{pageCount} pages</strong> into one invoice. Each item below is tagged with which page it came from — check the "Pg" badge if anything looks off.</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 p-2.5 bg-slate-50 border border-slate-200 rounded">
            <div className="space-y-0.5">
              <span className="text-[8px] uppercase tracking-wider font-bold text-slate-400">Supplier</span>
              <input type="text" className="w-full text-[10px] font-bold bg-white border border-slate-200 p-1 rounded focus:border-emerald-500 focus:outline-none" value={extractedData.supplierName} onChange={(e) => setExtractedData({ ...extractedData, supplierName: e.target.value })} />
            </div>
            <div className="space-y-0.5">
              <span className="text-[8px] uppercase tracking-wider font-bold text-slate-400">Docket Date</span>
              <input type="date" className="w-full text-[10px] bg-white border border-slate-200 p-1 rounded focus:border-emerald-500 focus:outline-none" value={extractedData.invoiceDate} onChange={(e) => setExtractedData({ ...extractedData, invoiceDate: e.target.value })} />
            </div>
            <div className="space-y-0.5">
              <span className="text-[8px] uppercase tracking-wider font-bold text-slate-400">Assigned Rep</span>
              <select className="w-full text-[10px] bg-white border border-slate-200 p-1 rounded focus:border-emerald-500 focus:outline-none" value={selectedRepId} onChange={(e) => setSelectedRepId(e.target.value)}>
                <option value="">-- Select Rep --</option>
                {reps.map(r => <option key={r.id} value={r.id}>{r.name} ({r.company})</option>)}
              </select>
            </div>
            <div className="space-y-0.5">
              <span className="text-[8px] uppercase tracking-wider font-bold text-slate-400">Grand Total</span>
              <div className="relative">
                <span className="absolute left-1.5 top-1 text-[10px] font-bold text-slate-400">$</span>
                <input type="number" step="0.01" className="w-full text-[10px] font-bold bg-white border border-slate-200 p-1 pl-4 rounded focus:border-emerald-500 focus:outline-none font-mono" value={extractedData.totalAmount} onChange={(e) => setExtractedData({ ...extractedData, totalAmount: parseFloat(e.target.value) || 0 })} />
              </div>
            </div>
          </div>

          {(extractedData.repPhone || extractedData.repEmail) && (
            <div className="flex items-center gap-3 p-2 bg-emerald-50/50 border border-emerald-100 rounded text-[10px] text-emerald-800">
              <span className="font-bold uppercase text-[8px] tracking-wider">Contact found on docket:</span>
              {extractedData.repPhone && <span>📞 {extractedData.repPhone}</span>}
              {extractedData.repEmail && <span>✉️ {extractedData.repEmail}</span>}
              <span className="text-[8px] text-emerald-600 ml-auto">Saved to rep profile automatically</span>
            </div>
          )}

          {gstNormalizedCount > 0 && (
            <div className="flex items-start gap-2 p-2 bg-indigo-50/60 border border-indigo-200 rounded text-[10px] text-indigo-800">
              <BadgePercent className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                <strong>{gstNormalizedCount} line{gstNormalizedCount > 1 ? "s" : ""}</strong> on this docket printed prices <strong>including GST</strong> — Unit Price has been automatically divided by 1.15 so it's stored excl-GST like every other product, matching the rest of the app. Lines adjusted are marked below with a badge showing the original printed figure. Double-check these before confirming.
              </span>
            </div>
          )}

          <div className="p-2 bg-emerald-50/60 border border-emerald-200 rounded text-[10px] text-emerald-800 leading-relaxed">
            <strong>Box Price = Unit Price × (1 − Disc%).</strong> Both numbers are extracted exactly as printed (Unit Price is shown here excl-GST, after automatic GST normalization if needed) and the discount is applied automatically. Lines with a 100% discount are flagged in amber — these are usually free/promo items and the $0.00 box price should NOT be used for retail pricing decisions. Matches are now verified by real word-overlap AND size/volume agreement before being accepted — if a line shows "No match," double-check it manually rather than assuming the database lacks the product.
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <h3 className="text-[11px] font-bold text-slate-700 flex items-center gap-1">
                <ShoppingBag className="h-3.5 w-3.5 text-emerald-600" />
                <span>Extracted Products — Review Before Saving</span>
              </h3>
              <div className="flex items-center gap-2">
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${matchedCount === totalCount ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                  {matchedCount}/{totalCount} matched
                </span>
              </div>
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded">
              <table className="w-full text-left text-[10px]" style={{ minWidth: "900px" }}>
                <thead>
                  <tr className="bg-slate-50 text-slate-500 font-bold uppercase text-[8px] border-b border-slate-200">
                    {pageCount > 1 && <th className="p-1 px-2 text-center" style={{ minWidth: "40px" }}>Pg</th>}
                    <th className="p-1 px-2.5" style={{ minWidth: "170px" }}>Database Match</th>
                    <th className="p-1 px-2.5" style={{ minWidth: "180px" }}>Product Name (from docket)</th>
                    <th className="p-1 px-2" style={{ minWidth: "110px" }}>Barcode / Code</th>
                    <th className="p-1 px-2 text-center" style={{ minWidth: "50px" }}>Qty</th>
                    <th className="p-1 px-2" style={{ minWidth: "100px" }}>Unit Price ($, excl. GST)</th>
                    <th className="p-1 px-2 text-center" style={{ minWidth: "70px" }}>Disc %</th>
                    <th className="p-1 px-2 text-right" style={{ minWidth: "90px" }}>Box Price ($)</th>
                    <th className="p-1 px-2 text-center" style={{ minWidth: "80px" }}>Units/Box</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {extractedData.items.map((item, index) => {
                    const discPercent = (item as any).discPercent ?? 0;
                    const isFreePromo = discPercent >= 100;
                    const originalIncGst = (item as any).originalUnitPriceIncGst;
                    const wasGstNormalized = originalIncGst != null;
                    const sourcePage = (item as any).sourcePage;
                    return (
                    <tr key={index} className={`hover:bg-slate-50/50 ${item.matchedProductId ? "" : "bg-amber-50/30"} ${isFreePromo ? "bg-amber-50" : ""}`}>

                      {pageCount > 1 && (
                        <td className="p-1 px-2 text-center">
                          {sourcePage && (
                            <span className="text-[8px] font-bold text-blue-700 bg-blue-50 border border-blue-200 px-1 py-0.5 rounded">{sourcePage}</span>
                          )}
                        </td>
                      )}

                      {/* DATABASE MATCH COLUMN */}
                      <td className="p-1 px-2" style={{ minWidth: "170px" }}>
                        {item.matchedProductId ? (
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-1 px-1.5 py-0.5 bg-emerald-50 text-emerald-800 rounded font-bold text-[9px] w-fit">
                              <Check className="h-3 w-3 shrink-0" />
                              <span className="font-mono">{item.matchedProductId}</span>
                            </div>
                            {(item as any).matchedProductName && (
                              <p className="text-[8px] text-slate-500 pl-1 line-clamp-1">{(item as any).matchedProductName}</p>
                            )}
                          </div>
                        ) : (
                          <div className="space-y-1">
                            <div className="flex items-center gap-1">
                              <span className="text-[9px] text-amber-700 bg-amber-50 border border-amber-200 px-1 py-0.5 rounded">No match</span>
                              <button
                                onClick={() => handleCreateNewProduct(index)}
                                title="Create as new product"
                                className="p-0.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded cursor-pointer"
                              >
                                <Plus className="h-3 w-3 text-emerald-600" />
                              </button>
                            </div>
                            {/* Manual barcode entry */}
                            <input
                              type="text"
                              placeholder="Enter barcode manually..."
                              className="w-full text-[9px] font-mono p-0.5 border border-slate-200 rounded focus:border-emerald-500 focus:outline-none bg-white"
                              onChange={(e) => {
                                if (e.target.value.length > 4) {
                                  handleUpdateItemField(index, "matchedProductId", e.target.value);
                                  handleUpdateItemField(index, "code", e.target.value);
                                }
                              }}
                            />
                          </div>
                        )}
                      </td>

                      {/* PRODUCT NAME */}
                      <td className="p-1 px-2" style={{ minWidth: "180px" }}>
                        <input type="text" className="bg-transparent border-b border-transparent hover:border-slate-300 focus:border-emerald-500 focus:outline-none p-0 text-[10px] font-bold text-slate-800 w-full" value={item.name} onChange={(e) => handleUpdateItemField(index, "name", e.target.value)} />
                        {isFreePromo && (
                          <span className="inline-flex items-center gap-0.5 mt-0.5 text-[8px] font-bold text-amber-700 bg-amber-100 px-1 py-0.5 rounded">
                            <Gift className="h-2.5 w-2.5" />
                            Free/Promo — verify before using for pricing
                          </span>
                        )}
                      </td>

                      {/* BARCODE / CODE */}
                      <td className="p-1 px-2">
                        <input type="text" className="bg-transparent border-b border-transparent hover:border-slate-300 focus:border-emerald-500 focus:outline-none p-0 text-[9px] font-mono text-slate-400 w-full" value={item.code || ""} onChange={(e) => handleUpdateItemField(index, "code", e.target.value)} placeholder="N/A" />
                      </td>

                      {/* QTY */}
                      <td className="p-1 px-2 text-center">
                        <input type="number" className="bg-transparent border-b border-transparent hover:border-slate-300 focus:border-emerald-500 focus:outline-none p-0 text-[10px] text-slate-800 w-full text-center font-bold" value={item.quantity} onChange={(e) => handleUpdateItemField(index, "quantity", parseInt(e.target.value) || 0)} />
                      </td>

                      {/* UNIT PRICE — pre-discount, excl-GST, editable */}
                      <td className="p-1 px-2">
                        <div className="relative">
                          <span className="absolute left-0 bottom-0 text-[9px] text-slate-400">$</span>
                          <input
                            type="number" step="0.01"
                            className="bg-transparent border-b border-transparent hover:border-slate-300 focus:border-emerald-500 focus:outline-none p-0 pl-2.5 text-[10px] w-full font-bold text-slate-800"
                            value={(item as any).unitPrice ?? 0}
                            onChange={(e) => handleUpdateItemField(index, "unitPrice" as any, parseFloat(e.target.value) || 0)}
                          />
                        </div>
                        {wasGstNormalized && (
                          <span
                            title="This docket's price column was labelled as including GST. The original printed figure was divided by 1.15 to get this excl-GST Unit Price."
                            className="inline-flex items-center gap-0.5 mt-0.5 text-[8px] font-bold text-indigo-700 bg-indigo-100 px-1 py-0.5 rounded cursor-help"
                          >
                            <BadgePercent className="h-2.5 w-2.5" />
                            GST removed (was ${originalIncGst.toFixed(2)} inc.)
                          </span>
                        )}
                      </td>

                      {/* DISC % — editable */}
                      <td className="p-1 px-2 text-center">
                        <input
                          type="number" min="0" max="100" step="0.01"
                          className={`bg-transparent border-b ${isFreePromo ? "border-amber-300 text-amber-700" : "border-transparent text-slate-800"} hover:border-slate-300 focus:border-emerald-500 focus:outline-none p-0 text-[10px] w-full text-center font-bold`}
                          value={discPercent}
                          onChange={(e) => handleUpdateItemField(index, "discPercent" as any, parseFloat(e.target.value) || 0)}
                        />
                      </td>

                      {/* BOX PRICE — computed, read-only */}
                      <td className="p-1 px-2 text-right">
                        <span className={`text-[10px] font-bold font-mono ${isFreePromo ? "text-amber-700" : "text-emerald-700"}`}>
                          ${item.price.toFixed(2)}
                        </span>
                      </td>

                      {/* UNITS PER BOX — editable, pre-filled from OCR */}
                      <td className="p-1 px-2 text-center">
                        <input
                          type="number"
                          min="1"
                          title="Number of individual units inside one box/carton, as printed on the docket"
                          className="bg-amber-50/60 border border-amber-200 hover:border-amber-300 focus:border-emerald-500 focus:outline-none p-0.5 text-[10px] text-slate-800 w-full text-center font-bold rounded"
                          value={(item as any).packQuantity ?? 1}
                          onChange={(e) => handleUpdateItemField(index, "packQuantity" as any, parseInt(e.target.value) || 1)}
                        />
                      </td>
                    </tr>
                  );})}
                </tbody>
              </table>
            </div>
            <p className="text-[9px] text-slate-400 pl-1">
              Box Price is calculated automatically as Unit Price × (1 − Disc%). Edit Unit Price or Disc% to correct a misread, and Box Price updates live. Units/Box is extracted as printed — divide Box Price by Units/Box yourself for per-unit cost. If a "GST removed" badge looks wrong (e.g. the docket was actually already excl-GST), just correct the Unit Price field directly — it's a normal editable field either way.
            </p>
          </div>

          <div className="flex justify-between items-center pt-2 border-t border-slate-200">
            <p className="text-[9px] text-slate-400">
              {totalCount - matchedCount > 0
                ? `${totalCount - matchedCount} unmatched products will be created as new in the database`
                : "All products matched — ready to save"}
            </p>
            <div className="flex gap-2">
              <button onClick={() => setStatus("idle")} className="px-2.5 py-1 border border-slate-200 hover:bg-slate-50 text-slate-600 text-[10px] font-semibold rounded cursor-pointer">
                Back
              </button>
              <button
                onClick={handleConfirmReviewSubmit}
                disabled={!selectedRepId}
                className="px-3 py-1 bg-emerald-700 hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-400 text-white text-[10px] font-bold rounded cursor-pointer flex items-center gap-1"
              >
                <UserCheck className="h-3.5 w-3.5" />
                <span>Confirm &amp; Save Prices</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SAVING */}
      {status === "saving" && (
        <div className="py-10 flex flex-col items-center justify-center space-y-3">
          <Loader2 className="h-8 w-8 text-emerald-600 animate-spin" />
          <h3 className="text-xs font-bold text-slate-800">Saving prices to database...</h3>
          <p className="text-[9px] text-slate-400">Creating price history entries per product per rep.</p>
        </div>
      )}

      {/* SUCCESS */}
      {status === "success" && (
        <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="py-8 text-center space-y-3">
          <div className="inline-flex items-center justify-center p-2 bg-emerald-100 rounded-full text-emerald-600">
            <Check className="h-6 w-6 stroke-[3px]" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-slate-900">Docket Processed Successfully</h3>
            <p className="text-[10px] text-slate-500 mt-0.5">All prices saved. Rep created if new. Price history updated.</p>
          </div>
          <button
            onClick={() => { setPendingFiles([]); setExtractedData(null); setStatus("idle"); setMatchingProgress(""); onScanConfirmed(); }}
            className="px-3 py-1 bg-slate-900 hover:bg-slate-800 text-white text-[10px] font-semibold rounded cursor-pointer"
          >
            Scan Another Docket
          </button>
        </motion.div>
      )}

      {/* COOLDOWN */}
      {status === "cooldown" && (
        <div className="py-8 text-center space-y-3">
          <div className="inline-flex items-center justify-center p-2 bg-amber-100 rounded-full text-amber-600">
            <Clock className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-amber-900">Gemini is busy right now</h3>
            <p className="text-[9px] text-amber-700 max-w-xs mx-auto mt-0.5 leading-normal">{errorMessage}</p>
          </div>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-full">
            <Loader2 className="h-3 w-3 text-amber-600 animate-spin" />
            <span className="text-[11px] font-bold text-amber-800 font-mono">Retry available in {cooldownSeconds}s</span>
          </div>
        </div>
      )}

      {/* ERROR */}
      {status === "error" && (
        <div className="py-8 text-center space-y-3">
          <div className="inline-flex items-center justify-center p-2 bg-rose-100 rounded-full text-rose-600">
            <AlertCircle className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-rose-900">Scan Failed</h3>
            <p className="text-[9px] text-rose-700 max-w-xs mx-auto mt-0.5 leading-normal">{errorMessage}</p>
          </div>
          <div className="flex justify-center gap-2">
            <button onClick={() => setStatus("idle")} className="px-3 py-1 border border-rose-200 hover:bg-rose-50 text-rose-900 text-[10px] font-semibold rounded cursor-pointer">Back</button>
            <button onClick={handleStartOCRScan} className="px-3 py-1 bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold rounded cursor-pointer flex items-center gap-1">
              <RefreshCw className="h-3 w-3" />
              <span>Retry</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}