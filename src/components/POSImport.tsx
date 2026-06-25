import React, { useState, useMemo } from "react";
import { Upload, FileText, CheckCircle2, AlertCircle, Info, Loader2 as LoaderIcon, Database, ArrowRight, TrendingUp, RefreshCw, PlusCircle, Search } from "lucide-react";
import { doc, writeBatch, serverTimestamp, collection, query, where, documentId, getDocs, getDoc, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { motion } from "motion/react";

interface POSImportProps {
  onImportComplete: () => void;
  // Kept for backwards compatibility with App.tsx, but no longer relied on
  // for duplicate detection — see handleExecuteImport, which checks Firestore
  // directly for the specific candidate IDs being imported right now.
  existingProductIds?: string[];
}

export interface PreviewProduct {
  id: string;
  barcode: string;
  name: string;
  category: string;
}

// Shape of a parsed row from the PRICING CSV (products_pricing.csv) —
// distinct from PreviewProduct above, which is for the "new products"
// import mode. This mode only ever PATCHES existing product docs by
// barcode — it never creates new products and never touches stock levels,
// lowStock, or preferredRepId. That separation matters: a pricing refresh
// should be safe to run repeatedly without risk to data set up elsewhere
// in the app (ProductCatalog's stock control, LowStockAlerts' preferred
// rep assignments, etc).
export interface PreviewPricingRow {
  barcode: string;
  name: string;
  category: string;
  costPrice: number;
  sellingPrice: number;
  margin: number;
  gpPercent: number;
  markupPercent: number;
  pricingFlag: string;
}

type ImportMode = "new-products" | "update-pricing" | "add-single";

export default function POSImport({ onImportComplete }: POSImportProps) {
  const [mode, setMode] = useState<ImportMode>("new-products");

  // ── "New Products" mode state (unchanged from before) ──────────────────
  const [csvText, setCsvText] = useState("");
  const [previewProducts, setPreviewProducts] = useState<PreviewProduct[]>([]);
  const [status, setStatus] = useState<"idle" | "parsed" | "checking" | "processing" | "success" | "error">("idle");
  const [log, setLog] = useState<string[]>([]);
  const [errorDetails, setErrorDetails] = useState("");
  const [importStats, setImportStats] = useState({ saved: 0, skippedDuplicates: 0, failed: 0 });
  const [confirmedDuplicateIds, setConfirmedDuplicateIds] = useState<Set<string>>(new Set());
  const [duplicateCheckDone, setDuplicateCheckDone] = useState(false);

  // ── "Update Pricing" mode state ─────────────────────────────────────────
  const [pricingCsvText, setPricingCsvText] = useState("");
  const [previewPricingRows, setPreviewPricingRows] = useState<PreviewPricingRow[]>([]);
  const [pricingStatus, setPricingStatus] = useState<"idle" | "parsed" | "checking" | "processing" | "success" | "error">("idle");
  const [pricingLog, setPricingLog] = useState<string[]>([]);
  const [pricingErrorDetails, setPricingErrorDetails] = useState("");
  const [pricingStats, setPricingStats] = useState({ updated: 0, notFound: 0, failed: 0 });
  // Set of barcodes confirmed to exist as real product docs in Firestore —
  // populated by checkPricingMatches() before patching, mirrors the
  // duplicate-check pattern from the new-products importer.
  const [confirmedExistingBarcodes, setConfirmedExistingBarcodes] = useState<Set<string>>(new Set());
  const [pricingMatchCheckDone, setPricingMatchCheckDone] = useState(false);

  // ── "Add Single Product" mode state (new) ──────────────────────────────
  const [singleBarcode, setSingleBarcode] = useState("");
  const [singleName, setSingleName] = useState("");
  const [singleCategory, setSingleCategory] = useState("");
  const [singleCostPrice, setSingleCostPrice] = useState("");
  const [singleSellingPrice, setSingleSellingPrice] = useState("");
  const [singleStatus, setSingleStatus] = useState<"idle" | "checking" | "saving" | "success" | "error" | "duplicate">("idle");
  const [singleErrorDetails, setSingleErrorDetails] = useState("");
  const [singleSavedName, setSingleSavedName] = useState("");

  const handleSampleLoad = () => {
    const sample = `Barcode,Product Name,Category\n94002624,Coca-Cola Can 330ml,Beverages\n94157670,Blue Powerade 750ml,Beverages\n94142312,Tip Top Jelly Tip Ice Cream,Frozen\n94192000,Anchor Blue Milk 2L,Dairy\n94030012,Watties Baked Beans 420g,Canned Goods\n94150077,Arnotts Chicken Crimpy 175g,Snacks\n,Loose Red Tomatoes,Fresh Produce\n,Bulk Crown Pumpkin,Fresh Produce`;
    setCsvText(sample);
  };

  const handleParseCSV = (textToParse: string) => {
    if (!textToParse.trim()) {
      setStatus("error");
      setErrorDetails("Please paste or upload some CSV data first.");
      return;
    }

    try {
      const lines = textToParse.split("\n");
      if (lines.length < 2) {
        throw new Error("CSV must contain at least a header row and one product record.");
      }

      const firstLine = lines[0].trim();
      const headerLine = firstLine.replace(/^\uFEFF/, "");

      let delimiter = ",";
      if (headerLine.includes(";")) {
        delimiter = ";";
      } else if (headerLine.includes("\t")) {
        delimiter = "\t";
      }

      const headers = headerLine.split(delimiter).map(h => h.replace(/^["']|["']$/g, "").trim().toLowerCase());

      let barcodeIdx = headers.findIndex(h =>
        h.includes("barcode") ||
        h.includes("sku") ||
        h.includes("code") ||
        h.includes("id") ||
        h.includes("upc") ||
        h.includes("ean") ||
        h.includes("isbn") ||
        h === "item" ||
        h.includes("item_no") ||
        h.includes("itemno") ||
        h.includes("part_no") ||
        h.includes("item number")
      );

      let nameIdx = headers.findIndex(h =>
        h.includes("name") ||
        h.includes("description") ||
        h.includes("descr") ||
        h.includes("desc") ||
        h.includes("title") ||
        h.includes("product") ||
        h.includes("label") ||
        (h === "item" && barcodeIdx !== headers.indexOf(h))
      );

      const categoryIdx = headers.findIndex(h =>
        h.includes("category") ||
        h.includes("department") ||
        h.includes("dept") ||
        h.includes("type") ||
        h.includes("group")
      );

      if (barcodeIdx === -1 && nameIdx !== -1) {
        barcodeIdx = headers.findIndex((_, idx) => idx !== nameIdx);
      } else if (nameIdx === -1 && barcodeIdx !== -1) {
        nameIdx = headers.findIndex((_, idx) => idx !== barcodeIdx);
      } else if (barcodeIdx === -1 && nameIdx === -1) {
        if (headers.length >= 2) {
          barcodeIdx = 0;
          nameIdx = 1;
        } else {
          throw new Error("Unable to identify Barcode and Product Name columns.");
        }
      }

      const candidates: PreviewProduct[] = [];
      let skippedLines = 0;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        let parts: string[] = [];
        let insideQuotes = false;
        let currentPart = "";

        for (let charIdx = 0; charIdx < line.length; charIdx++) {
          const char = line[charIdx];
          if (char === '"') {
            insideQuotes = !insideQuotes;
          } else if (char === delimiter && !insideQuotes) {
            parts.push(currentPart.trim());
            currentPart = "";
          } else {
            currentPart += char;
          }
        }
        parts.push(currentPart.trim());
        parts = parts.map(p => p.replace(/^"|"$/g, "").trim());

        const rawBarcode = parts[barcodeIdx] || "";
        const rawName = parts[nameIdx] || "";
        const rawCategory = categoryIdx !== -1 && parts[categoryIdx] ? parts[categoryIdx] : "General";

        if (!rawBarcode && !rawName) {
          skippedLines++;
          continue;
        }

        let cleanId = "";
        if (rawBarcode) {
          cleanId = rawBarcode.replace(/[^a-zA-Z0-9_\-\+\.]/g, "");
        }

        if (!cleanId && rawName) {
          cleanId = rawName
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-zA-Z0-9_\-\+\.]/g, "");
        }

        if (!cleanId) {
          skippedLines++;
          continue;
        }

        candidates.push({
          id: cleanId,
          barcode: rawBarcode,
          name: rawName || "Unnamed POS Product",
          category: rawCategory
        });
      }

      if (candidates.length === 0) {
        throw new Error("No valid products were parsed from the CSV rows. Please verify CSV columns.");
      }

      setPreviewProducts(candidates);
      setConfirmedDuplicateIds(new Set());
      setDuplicateCheckDone(false);
      setStatus("parsed");
      setLog([
        `Parsed successfully. Compiled ${candidates.length} products ready for import.`,
        skippedLines > 0 ? `Skipped ${skippedLines} empty or incomplete lines.` : "All rows loaded."
      ]);
    } catch (err: any) {
      console.error("CSV Parsing Error:", err);
      setStatus("error");
      setErrorDetails(err.message || "Unknown error during CSV parsing.");
    }
  };

  // Checks Firestore directly for exactly the IDs in this CSV — chunked by 30
  // (Firestore "in" query limit). This scales correctly regardless of how
  // large the overall product catalog is, since we never load the whole
  // collection — only ask "do these specific IDs exist?"
  const checkExistingIds = async (ids: string[]): Promise<Set<string>> => {
    const found = new Set<string>();
    const BATCH_SIZE = 30;

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batchIds = ids.slice(i, i + BATCH_SIZE);
      const snap = await getDocs(
        query(collection(db, "products"), where(documentId(), "in", batchIds))
      );
      snap.forEach(d => found.add(d.id));
    }

    return found;
  };

  const handleCheckDuplicates = async () => {
    setStatus("checking");
    setLog(["Checking which products already exist in the database..."]);
    try {
      const ids = previewProducts.map(p => p.id);
      const existing = await checkExistingIds(ids);
      setConfirmedDuplicateIds(existing);
      setDuplicateCheckDone(true);
      setStatus("parsed");
      setLog(prev => [
        ...prev,
        `Checked ${ids.length} products against the database.`,
        `${existing.size} already exist and will be skipped.`,
        `${ids.length - existing.size} are new.`
      ]);
    } catch (err: any) {
      console.error("Duplicate check error:", err);
      setStatus("error");
      setErrorDetails(err.message || "Failed to check for existing products.");
    }
  };

  const handleExecuteImport = async () => {
    setStatus("processing");
    setLog(["Initializing batch import..."]);

    let saved = 0;
    let skipped = 0;

    try {
      // Always re-verify duplicates right before writing — covers the case
      // where the user skipped the explicit check step, and protects against
      // staleness if anything changed in the DB since parsing.
      const ids = previewProducts.map(p => p.id);
      const existingIds = duplicateCheckDone ? confirmedDuplicateIds : await checkExistingIds(ids);

      const newProducts = previewProducts.filter(item => !existingIds.has(item.id));
      skipped = previewProducts.length - newProducts.length;

      const BATCH_SIZE = 500;
      for (let i = 0; i < newProducts.length; i += BATCH_SIZE) {
        const batch = writeBatch(db);
        const chunk = newProducts.slice(i, i + BATCH_SIZE);

        chunk.forEach(item => {
          const productRef = doc(db, "products", item.id);
          batch.set(productRef, {
            id: item.id,
            name: item.name,
            sku: item.barcode || item.id,
            category: item.category || "General",
            lowStock: false,
            preferredRepId: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        });

        await batch.commit();
        saved += chunk.length;
        setLog(prev => [...prev, `Imported ${saved}/${newProducts.length} products...`]);
      }

      setImportStats({ saved, skippedDuplicates: skipped, failed: 0 });
      setLog(prev => [
        ...prev,
        "---------- Import Complete ----------",
        `Saved: ${saved} products.`,
        skipped > 0 ? `Skipped ${skipped} duplicates (already existed).` : "No duplicates found."
      ]);
      setStatus("success");
      onImportComplete();
    } catch (err: any) {
      console.error("Import error:", err);
      setStatus("error");
      setErrorDetails(err.message || "An error occurred during import.");
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setStatus("processing");
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      setCsvText(text);
      handleParseCSV(text);
    };
    reader.onerror = () => {
      setStatus("error");
      setErrorDetails("Error reading selected local CSV file.");
    };
    reader.readAsText(file);
  };

  const previewMetrics = useMemo(() => {
    const duplicateCount = duplicateCheckDone
      ? previewProducts.filter(p => confirmedDuplicateIds.has(p.id)).length
      : 0;
    return {
      total: previewProducts.length,
      duplicates: duplicateCount,
      newToImport: previewProducts.length - duplicateCount
    };
  }, [previewProducts, confirmedDuplicateIds, duplicateCheckDone]);

  // ── "Update Pricing" mode logic ─────────────────────────────────────────

  const handlePricingSampleLoad = () => {
    const sample = `Barcode,Product Name,Category,Cost Price,Selling Price,Margin,GP Percent,Markup Percent,Flag\n9420025400028,CHECK OIL 2L CANOLA,16,5.00,6.99,1.99,28.47,39.80,\n9300633135423,ESSENTIALS CLING WRAP 60M,19,3.00,5.99,2.99,49.92,99.67,`;
    setPricingCsvText(sample);
  };

  // Parses the pricing CSV produced specifically for this importer
  // (products_pricing.csv): Barcode, Product Name, Category, Cost Price,
  // Selling Price, Margin, GP Percent, Markup Percent, Flag. Deliberately
  // simpler/stricter than handleParseCSV above — this file's column order
  // and headers are known and controlled (it's generated, not an
  // arbitrary external export), so this avoids the heuristic column
  // detection used for the new-products importer, which isn't needed here
  // and would just add room for misparsing a price as a name or similar.
  const handleParsePricingCSV = (textToParse: string) => {
    if (!textToParse.trim()) {
      setPricingStatus("error");
      setPricingErrorDetails("Please paste or upload some CSV data first.");
      return;
    }

    try {
      const lines = textToParse.split("\n").filter(l => l.trim());
      if (lines.length < 2) {
        throw new Error("CSV must contain at least a header row and one pricing record.");
      }

      const headerLine = lines[0].replace(/^\uFEFF/, "").trim();
      const headers = headerLine.split(",").map(h => h.replace(/^["']|["']$/g, "").trim().toLowerCase());

      const findCol = (...names: string[]) => headers.findIndex(h => names.includes(h));
      const idx = {
        barcode: findCol("barcode"),
        name: findCol("product name", "name"),
        category: findCol("category"),
        costPrice: findCol("cost price", "lastcost", "last cost"),
        sellingPrice: findCol("selling price", "price"),
        margin: findCol("margin"),
        gpPercent: findCol("gp percent", "gp %", "gp"),
        markupPercent: findCol("markup percent", "markup %", "markup"),
        flag: findCol("flag")
      };

      if (idx.barcode === -1 || idx.costPrice === -1 || idx.sellingPrice === -1) {
        throw new Error("CSV must contain Barcode, Cost Price, and Selling Price columns. Check the file came from the correct export.");
      }

      const parseLine = (line: string): string[] => {
        const parts: string[] = [];
        let insideQuotes = false;
        let current = "";
        for (const char of line) {
          if (char === '"') insideQuotes = !insideQuotes;
          else if (char === "," && !insideQuotes) {
            parts.push(current.trim());
            current = "";
          } else current += char;
        }
        parts.push(current.trim());
        return parts.map(p => p.replace(/^"|"$/g, "").trim());
      };

      const rows: PreviewPricingRow[] = [];
      let skipped = 0;

      for (let i = 1; i < lines.length; i++) {
        const parts = parseLine(lines[i]);
        const barcode = parts[idx.barcode] || "";
        const costPrice = parseFloat(parts[idx.costPrice]);
        const sellingPrice = parseFloat(parts[idx.sellingPrice]);

        if (!barcode || isNaN(costPrice) || isNaN(sellingPrice)) {
          skipped++;
          continue;
        }

        rows.push({
          barcode,
          name: idx.name !== -1 ? (parts[idx.name] || "") : "",
          category: idx.category !== -1 ? (parts[idx.category] || "") : "",
          costPrice,
          sellingPrice,
          margin: idx.margin !== -1 ? parseFloat(parts[idx.margin]) || 0 : Math.round((sellingPrice - costPrice) * 100) / 100,
          gpPercent: idx.gpPercent !== -1 ? parseFloat(parts[idx.gpPercent]) || 0 : Math.round(((sellingPrice - costPrice) / sellingPrice) * 10000) / 100,
          markupPercent: idx.markupPercent !== -1 ? parseFloat(parts[idx.markupPercent]) || 0 : Math.round(((sellingPrice - costPrice) / costPrice) * 10000) / 100,
          pricingFlag: idx.flag !== -1 ? (parts[idx.flag] || "") : ""
        });
      }

      if (rows.length === 0) {
        throw new Error("No valid pricing rows were parsed. Please verify the CSV columns and values.");
      }

      setPreviewPricingRows(rows);
      setConfirmedExistingBarcodes(new Set());
      setPricingMatchCheckDone(false);
      setPricingStatus("parsed");
      setPricingLog([
        `Parsed successfully. Compiled ${rows.length} pricing records ready to apply.`,
        skipped > 0 ? `Skipped ${skipped} rows with missing barcode, cost, or selling price.` : "All rows loaded."
      ]);
    } catch (err: any) {
      console.error("Pricing CSV Parsing Error:", err);
      setPricingStatus("error");
      setPricingErrorDetails(err.message || "Unknown error during CSV parsing.");
    }
  };

  // Confirms which barcodes in this CSV actually correspond to existing
  // product docs in Firestore — chunked by 30, same "in" query pattern as
  // checkExistingIds above. Anything not found here is reported as
  // "not found", never created — that's the core safety property of this
  // importer: it can only ever patch products that already exist.
  const checkPricingMatches = async (barcodes: string[]): Promise<Set<string>> => {
    const found = new Set<string>();
    const BATCH_SIZE = 30;

    for (let i = 0; i < barcodes.length; i += BATCH_SIZE) {
      const batchIds = barcodes.slice(i, i + BATCH_SIZE);
      const snap = await getDocs(
        query(collection(db, "products"), where(documentId(), "in", batchIds))
      );
      snap.forEach(d => found.add(d.id));
    }

    return found;
  };

  const handleCheckPricingMatches = async () => {
    setPricingStatus("checking");
    setPricingLog(["Checking which barcodes match existing products..."]);
    try {
      const barcodes = previewPricingRows.map(r => r.barcode);
      const existing = await checkPricingMatches(barcodes);
      setConfirmedExistingBarcodes(existing);
      setPricingMatchCheckDone(true);
      setPricingStatus("parsed");
      setPricingLog(prev => [
        ...prev,
        `Checked ${barcodes.length} barcodes against the database.`,
        `${existing.size} matched an existing product and will be updated.`,
        `${barcodes.length - existing.size} did not match any existing product and will be skipped.`
      ]);
    } catch (err: any) {
      console.error("Pricing match check error:", err);
      setPricingStatus("error");
      setPricingErrorDetails(err.message || "Failed to check for matching products.");
    }
  };

  // Applies costPrice/sellingPrice/margin/gpPercent/markupPercent/
  // pricingFlag onto EXISTING product docs only, via updateDoc (never
  // setDoc/create). Deliberately does not touch name, sku, category,
  // lowStock, currentStock, minStockLevel, or preferredRepId — those are
  // managed elsewhere (ProductCatalog's stock controls, LowStockAlerts'
  // preferred-rep assignment) and a pricing refresh should never silently
  // reset them. Rows with no matching product doc are counted as
  // "not found" and skipped, never used to create a new product — that's
  // the new-products importer's job, not this one's.
  const handleApplyPricingUpdate = async () => {
    setPricingStatus("processing");
    setPricingLog(["Applying pricing updates..."]);

    let updated = 0;
    let notFound = 0;
    let failed = 0;

    try {
      const barcodes = previewPricingRows.map(r => r.barcode);
      const existingBarcodes = pricingMatchCheckDone ? confirmedExistingBarcodes : await checkPricingMatches(barcodes);

      const rowsToApply = previewPricingRows.filter(r => existingBarcodes.has(r.barcode));
      notFound = previewPricingRows.length - rowsToApply.length;

      const BATCH_SIZE = 500;
      for (let i = 0; i < rowsToApply.length; i += BATCH_SIZE) {
        const batch = writeBatch(db);
        const chunk = rowsToApply.slice(i, i + BATCH_SIZE);

        chunk.forEach(row => {
          const productRef = doc(db, "products", row.barcode);
          batch.update(productRef, {
            costPrice: row.costPrice,
            sellingPrice: row.sellingPrice,
            margin: row.margin,
            gpPercent: row.gpPercent,
            markupPercent: row.markupPercent,
            pricingFlag: row.pricingFlag || null,
            updatedAt: serverTimestamp()
          });
        });

        try {
          await batch.commit();
          updated += chunk.length;
          setPricingLog(prev => [...prev, `Updated ${updated}/${rowsToApply.length} products...`]);
        } catch (batchErr: any) {
          console.error("Batch update failed:", batchErr);
          failed += chunk.length;
          setPricingLog(prev => [...prev, `A batch of ${chunk.length} failed to update — see console for details.`]);
        }
      }

      setPricingStats({ updated, notFound, failed });
      setPricingLog(prev => [
        ...prev,
        "---------- Pricing Update Complete ----------",
        `Updated: ${updated} products.`,
        notFound > 0 ? `Skipped ${notFound} barcodes with no matching product (not created).` : "Every barcode matched an existing product.",
        failed > 0 ? `${failed} products failed to update — check console.` : ""
      ].filter(Boolean));
      setPricingStatus("success");
      onImportComplete();
    } catch (err: any) {
      console.error("Pricing update error:", err);
      setPricingStatus("error");
      setPricingErrorDetails(err.message || "An error occurred while applying pricing updates.");
    }
  };

  const handlePricingFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setPricingStatus("processing");
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      setPricingCsvText(text);
      handleParsePricingCSV(text);
    };
    reader.onerror = () => {
      setPricingStatus("error");
      setPricingErrorDetails("Error reading selected local CSV file.");
    };
    reader.readAsText(file);
  };

  const pricingPreviewMetrics = useMemo(() => {
    const matchedCount = pricingMatchCheckDone
      ? previewPricingRows.filter(r => confirmedExistingBarcodes.has(r.barcode)).length
      : 0;
    const flaggedCount = previewPricingRows.filter(r => r.pricingFlag === "LOSS_OR_BREAKEVEN").length;
    return {
      total: previewPricingRows.length,
      matched: matchedCount,
      notFound: previewPricingRows.length - matchedCount,
      flagged: flaggedCount
    };
  }, [previewPricingRows, confirmedExistingBarcodes, pricingMatchCheckDone]);

  // ── "Add Single Product" mode logic (new) ──────────────────────────────

  // Live margin preview as the manager types — only shown once both Cost
  // Price and Selling Price are valid positive numbers. Pricing fields are
  // entirely OPTIONAL for a manually-added product (e.g. adding a barcode
  // discovered on a docket scan with no POS pricing data yet) — if either
  // is left blank, the product is still created, just without pricing
  // data, the same "no pricing data on file" state ProductCatalog already
  // handles gracefully for any other product.
  const singlePricingPreview = useMemo(() => {
    const cost = parseFloat(singleCostPrice);
    const selling = parseFloat(singleSellingPrice);
    if (isNaN(cost) || isNaN(selling) || cost <= 0 || selling <= 0) return null;
    const margin = Math.round((selling - cost) * 100) / 100;
    const gpPercent = Math.round(((selling - cost) / selling) * 10000) / 100;
    const markupPercent = Math.round(((selling - cost) / cost) * 10000) / 100;
    const pricingFlag = cost >= selling ? "LOSS_OR_BREAKEVEN" : "";
    return { cost, selling, margin, gpPercent, markupPercent, pricingFlag };
  }, [singleCostPrice, singleSellingPrice]);

  const resetSingleForm = () => {
    setSingleBarcode("");
    setSingleName("");
    setSingleCategory("");
    setSingleCostPrice("");
    setSingleSellingPrice("");
    setSingleStatus("idle");
    setSingleErrorDetails("");
  };

  // Cleans the barcode the same way handleParseCSV does for the bulk
  // importer, so a manually-typed barcode and a CSV-imported one always
  // normalize to the same document ID — prevents a near-duplicate (e.g.
  // stray whitespace or punctuation) silently creating a second product
  // for what's really the same barcode.
  const cleanBarcode = (raw: string): string => raw.trim().replace(/[^a-zA-Z0-9_\-\+\.]/g, "");

  // Checks Firestore for this exact barcode BEFORE writing anything —
  // mirrors the duplicate-check discipline used everywhere else in this
  // file. A manually-added product is just as capable of silently
  // overwriting existing data as a bad CSV row would be, so it gets the
  // same protection: block the save and tell the manager plainly rather
  // than letting setDoc clobber an existing product.
  const handleSaveSingleProduct = async () => {
    setSingleErrorDetails("");
    const id = cleanBarcode(singleBarcode);
    const name = singleName.trim();

    if (!id) {
      setSingleStatus("error");
      setSingleErrorDetails("Barcode is required and must contain at least one letter or number.");
      return;
    }
    if (!name) {
      setSingleStatus("error");
      setSingleErrorDetails("Product Name is required.");
      return;
    }

    setSingleStatus("checking");
    try {
      const existingSnap = await getDoc(doc(db, "products", id));
      if (existingSnap.exists()) {
        const existingData = existingSnap.data();
        setSingleStatus("duplicate");
        setSingleErrorDetails(`Barcode ${id} already exists as "${existingData.name || "an existing product"}". Search for it in the Product Catalog to edit it instead, or use a different barcode.`);
        return;
      }

      setSingleStatus("saving");
      const payload: any = {
        id,
        name,
        sku: id,
        category: singleCategory.trim() || "General",
        lowStock: false,
        preferredRepId: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };

      // Pricing fields are written together, only when BOTH are present
      // and valid — same all-or-nothing rule the importer and the inline
      // ProductCatalog editor follow, so a product never ends up with a
      // costPrice but no sellingPrice (or vice versa), which would make
      // hasPricingData checks elsewhere unreliable.
      if (singlePricingPreview) {
        payload.costPrice = singlePricingPreview.cost;
        payload.sellingPrice = singlePricingPreview.selling;
        payload.margin = singlePricingPreview.margin;
        payload.gpPercent = singlePricingPreview.gpPercent;
        payload.markupPercent = singlePricingPreview.markupPercent;
        payload.pricingFlag = singlePricingPreview.pricingFlag || null;
      }

      await setDoc(doc(db, "products", id), payload);
      setSingleSavedName(name);
      setSingleStatus("success");
      onImportComplete();
    } catch (err: any) {
      console.error("Add single product error:", err);
      setSingleStatus("error");
      setSingleErrorDetails(err.message || "Failed to save the new product. Please try again.");
    }
  };

  return (
    <div className="bg-white rounded-md shadow-xs border border-slate-250 p-4">
      <div className="flex items-center gap-1.5 mb-2.5">
        <FileText className="h-4 w-4 text-emerald-600" />
        <h2 className="text-sm font-bold text-slate-900">Idealpos CSV Product Import</h2>
      </div>

      {/* MODE TOGGLE */}
      <div className="flex gap-1.5 mb-3 p-1 bg-slate-100 rounded-lg w-fit flex-wrap">
        <button
          onClick={() => setMode("new-products")}
          className={`px-3 py-1.5 text-[11px] font-bold rounded-md cursor-pointer transition-all flex items-center gap-1.5 ${
            mode === "new-products" ? "bg-white text-emerald-700 shadow-sm" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          <Database className="h-3.5 w-3.5" />
          <span>Import New Products</span>
        </button>
        <button
          onClick={() => setMode("update-pricing")}
          className={`px-3 py-1.5 text-[11px] font-bold rounded-md cursor-pointer transition-all flex items-center gap-1.5 ${
            mode === "update-pricing" ? "bg-white text-emerald-700 shadow-sm" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          <TrendingUp className="h-3.5 w-3.5" />
          <span>Update Pricing &amp; Margins</span>
        </button>
        <button
          onClick={() => { setMode("add-single"); resetSingleForm(); }}
          className={`px-3 py-1.5 text-[11px] font-bold rounded-md cursor-pointer transition-all flex items-center gap-1.5 ${
            mode === "add-single" ? "bg-white text-emerald-700 shadow-sm" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          <PlusCircle className="h-3.5 w-3.5" />
          <span>Add Single Product</span>
        </button>
      </div>

      {/* ════════════════════ NEW PRODUCTS MODE (unchanged) ════════════════════ */}
      {mode === "new-products" && (
        <>
          <p className="text-[11px] text-slate-500 mb-3 leading-relaxed">
            Export your supermarket master product database from your Idealpos POS system as a CSV file and import it below.
          </p>

          <div className="bg-emerald-50/50 rounded p-2.5 mb-3 border border-emerald-100 flex items-start gap-2">
            <Info className="h-3.5 w-3.5 text-emerald-700 shrink-0 mt-0.5" />
            <div className="text-[10px] text-emerald-800 leading-relaxed w-full">
              <p className="font-bold flex items-center justify-between">
                <span>Expected CSV format:</span>
                <button
                  type="button"
                  onClick={handleSampleLoad}
                  className="text-emerald-700 underline font-medium hover:text-emerald-950 cursor-pointer text-[10px]"
                >
                  Load Sample Data
                </button>
              </p>
              <p className="mt-0.5 text-slate-600">Must contain column headers for Barcode and Product Name.</p>
            </div>
          </div>

          {(status === "idle" || status === "parsed" || status === "checking") && (
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1" htmlFor="csv_text_input">
                  Paste POS CSV Text
                </label>
                <textarea
                  id="csv_text_input"
                  rows={4}
                  className="w-full text-[10px] font-mono p-2 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 bg-slate-50/50"
                  placeholder="Barcode,Product Name,Category"
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                />
              </div>

              <div className="flex gap-2.5 items-center">
                <button
                  onClick={() => handleParseCSV(csvText)}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white text-[11px] font-semibold rounded cursor-pointer transition-colors"
                >
                  Parse Data Preview
                </button>
                <span className="text-[10px] font-bold text-slate-350">OR</span>
                <label className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded text-[11px] hover:bg-slate-50 text-slate-600 cursor-pointer transition-colors">
                  <Upload className="h-3.5 w-3.5 text-slate-400" />
                  <span>Choose CSV File</span>
                  <input
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={handleFileUpload}
                  />
                </label>
              </div>

              {status === "parsed" && previewProducts.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="border-t border-slate-150 pt-4 text-left"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <h3 className="text-xs font-bold text-slate-800">CSV Parsing Results</h3>
                      <p className="text-[10px] text-slate-550">
                        Parsed <strong>{previewMetrics.total}</strong> products.{" "}
                        {!duplicateCheckDone ? (
                          <span className="text-amber-700">Run a duplicate check before importing.</span>
                        ) : previewMetrics.duplicates > 0 ? (
                          <span>
                            (<span className="text-amber-700 font-bold">{previewMetrics.duplicates}</span> duplicates will be skipped).
                          </span>
                        ) : (
                          <span className="text-emerald-700">No duplicates found — all new.</span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {!duplicateCheckDone && (
                        <button
                          onClick={handleCheckDuplicates}
                          className="text-[10px] text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 px-2 py-1 rounded font-bold cursor-pointer"
                        >
                          Check Duplicates
                        </button>
                      )}
                      {duplicateCheckDone && (
                        <div className="text-right text-[10px] text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded font-bold">
                          {previewMetrics.newToImport} New Products
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="border border-slate-200 rounded-md max-h-56 overflow-y-auto mb-4 bg-white">
                    <table className="w-full text-[10px] border-collapse">
                      <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-10">
                        <tr className="font-bold text-slate-500 uppercase text-[8px] tracking-wider text-left">
                          <th className="p-2 pl-3">Barcode / SKU</th>
                          <th className="p-2">Product Name</th>
                          <th className="p-2 pr-3">Category</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {previewProducts.map((p, idx) => {
                          const isDuplicate = duplicateCheckDone && confirmedDuplicateIds.has(p.id);
                          return (
                            <tr key={idx} className={`hover:bg-slate-50/50 ${isDuplicate ? "bg-amber-50/30 text-slate-450" : ""}`}>
                              <td className="p-2 pl-3 font-mono text-[9px] font-medium">
                                {p.barcode ? (
                                  <span>{p.barcode}</span>
                                ) : (
                                  <span className="text-amber-700 bg-amber-50 px-1 rounded text-[8px] font-bold">
                                    No Barcode
                                  </span>
                                )}
                              </td>
                              <td className="p-2 font-bold text-slate-800">
                                {p.name}
                                {isDuplicate && (
                                  <span className="ml-1.5 text-[8px] bg-amber-100 text-amber-800 px-1 rounded font-normal">
                                    Duplicate (Will Skip)
                                  </span>
                                )}
                              </td>
                              <td className="p-2 pr-3 text-slate-500">{p.category}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="bg-slate-50 border border-slate-200 rounded p-3 flex flex-col sm:flex-row items-center justify-between gap-3">
                    <div className="text-[10px] text-slate-600 leading-snug">
                      <p className="font-bold text-slate-800">Ready for Database Import</p>
                      <p>Products will be written in batches of 500 for maximum speed.</p>
                      {!duplicateCheckDone && (
                        <p className="text-amber-700 mt-0.5">Duplicate check will run automatically before import if skipped.</p>
                      )}
                    </div>
                    <button
                      onClick={handleExecuteImport}
                      className="w-full sm:w-auto px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-[11px] font-bold rounded flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                    >
                      <Database className="h-3.5 w-3.5" />
                      <span>
                        {duplicateCheckDone
                          ? `Import ${previewMetrics.newToImport} Products to Database`
                          : `Import ${previewMetrics.total} Products to Database`}
                      </span>
                    </button>
                  </div>
                </motion.div>
              )}
            </div>
          )}

          {status === "checking" && (
            <div className="py-6 flex flex-col items-center justify-center space-y-3">
              <LoaderIcon className="animate-spin h-7 w-7 text-emerald-600" />
              <div className="text-center">
                <p className="text-[11px] font-bold text-slate-700">Checking for existing products in Firestore...</p>
                <p className="text-[9px] text-slate-400 mt-0.5">Querying in batches of 30 by document ID — no full collection scan.</p>
              </div>
            </div>
          )}

          {status === "processing" && (
            <div className="py-6 flex flex-col items-center justify-center space-y-3">
              <LoaderIcon className="animate-spin h-7 w-7 text-emerald-600" />
              <div className="text-center">
                <p className="text-[11px] font-bold text-slate-700">Writing Products to Firebase Firestore...</p>
                <p className="text-[9px] text-slate-400 mt-0.5">Importing in batches of 500 — much faster now!</p>
              </div>
              <div className="w-full max-w-lg bg-slate-900 text-slate-100 rounded p-2.5 h-32 overflow-y-auto text-left text-[9px] font-mono border border-slate-800 leading-relaxed">
                {log.map((line, idx) => (
                  <div key={idx} className="opacity-90">
                    <span className="text-emerald-400 font-bold mr-1">&gt;</span>
                    {line}
                  </div>
                ))}
              </div>
            </div>
          )}

          {status === "success" && (
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              className="p-4 bg-emerald-50/50 rounded border border-emerald-250 text-center space-y-3"
            >
              <div className="inline-flex items-center justify-center p-2.5 bg-emerald-100 rounded-full text-emerald-600">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-emerald-950">Successfully imported {importStats.saved} products</h3>
                <p className="text-[10px] text-emerald-800 mt-1 leading-snug">
                  {importStats.skippedDuplicates > 0 && `Skipped ${importStats.skippedDuplicates} duplicates.`}
                </p>
              </div>
              <div className="text-left text-[9px] bg-white p-3 rounded-md max-h-28 overflow-y-auto font-mono text-slate-600 border border-emerald-150">
                {log.map((l, idx) => (
                  <div key={idx} className="flex gap-1.5 items-start mt-0.5">
                    <span className="text-emerald-600 font-bold">✓</span>
                    <span>{l}</span>
                  </div>
                ))}
              </div>
              <div className="pt-2 flex justify-center gap-2">
                <button
                  onClick={() => {
                    setCsvText("");
                    setPreviewProducts([]);
                    setConfirmedDuplicateIds(new Set());
                    setDuplicateCheckDone(false);
                    setStatus("idle");
                  }}
                  className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-[10px] font-bold rounded cursor-pointer border border-slate-200"
                >
                  Import Another CSV
                </button>
                <button
                  onClick={onImportComplete}
                  className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-[10px] font-bold rounded cursor-pointer flex items-center gap-1"
                >
                  <span>Verify in Catalog</span>
                  <ArrowRight className="h-3 w-3" />
                </button>
              </div>
            </motion.div>
          )}

          {status === "error" && (
            <div className="p-4 bg-rose-50 rounded border border-rose-200 text-center space-y-2.5">
              <div className="inline-flex items-center justify-center p-2 bg-rose-100 rounded-full text-rose-600">
                <AlertCircle className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-rose-900">POS Import Failed</h3>
                <p className="text-[10px] text-rose-700 mt-0.5">{errorDetails}</p>
              </div>
              <button
                onClick={() => setStatus("idle")}
                className="px-3 py-1 bg-slate-800 hover:bg-slate-900 text-white text-[10px] font-semibold rounded cursor-pointer"
              >
                Dismiss &amp; Retry
              </button>
            </div>
          )}
        </>
      )}

      {/* ════════════════════ UPDATE PRICING MODE ════════════════════ */}
      {mode === "update-pricing" && (
        <>
          <p className="text-[11px] text-slate-500 mb-3 leading-relaxed">
            Upload the pricing CSV (Barcode, Cost Price, Selling Price, Margin, GP%, Markup%) to patch cost and margin data onto your <strong>existing</strong> products. This never creates new products and never touches stock levels or preferred reps — only barcodes that already exist in your catalog get updated.
          </p>

          <div className="bg-indigo-50/50 rounded p-2.5 mb-3 border border-indigo-100 flex items-start gap-2">
            <Info className="h-3.5 w-3.5 text-indigo-700 shrink-0 mt-0.5" />
            <div className="text-[10px] text-indigo-800 leading-relaxed w-full">
              <p className="font-bold flex items-center justify-between">
                <span>Expected CSV format:</span>
                <button
                  type="button"
                  onClick={handlePricingSampleLoad}
                  className="text-indigo-700 underline font-medium hover:text-indigo-950 cursor-pointer text-[10px]"
                >
                  Load Sample Data
                </button>
              </p>
              <p className="mt-0.5 text-slate-600">Must contain Barcode, Cost Price, and Selling Price columns. Margin/GP%/Markup%/Flag are recalculated automatically if missing.</p>
            </div>
          </div>

          {(pricingStatus === "idle" || pricingStatus === "parsed" || pricingStatus === "checking") && (
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1" htmlFor="pricing_csv_text_input">
                  Paste Pricing CSV Text
                </label>
                <textarea
                  id="pricing_csv_text_input"
                  rows={4}
                  className="w-full text-[10px] font-mono p-2 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-slate-50/50"
                  placeholder="Barcode,Product Name,Category,Cost Price,Selling Price,Margin,GP Percent,Markup Percent,Flag"
                  value={pricingCsvText}
                  onChange={(e) => setPricingCsvText(e.target.value)}
                />
              </div>

              <div className="flex gap-2.5 items-center">
                <button
                  onClick={() => handleParsePricingCSV(pricingCsvText)}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white text-[11px] font-semibold rounded cursor-pointer transition-colors"
                >
                  Parse Data Preview
                </button>
                <span className="text-[10px] font-bold text-slate-350">OR</span>
                <label className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded text-[11px] hover:bg-slate-50 text-slate-600 cursor-pointer transition-colors">
                  <Upload className="h-3.5 w-3.5 text-slate-400" />
                  <span>Choose CSV File</span>
                  <input
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={handlePricingFileUpload}
                  />
                </label>
              </div>

              {pricingStatus === "parsed" && previewPricingRows.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="border-t border-slate-150 pt-4 text-left"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <h3 className="text-xs font-bold text-slate-800">Pricing CSV Parsing Results</h3>
                      <p className="text-[10px] text-slate-550">
                        Parsed <strong>{pricingPreviewMetrics.total}</strong> pricing records.{" "}
                        {!pricingMatchCheckDone ? (
                          <span className="text-amber-700">Run a match check before applying.</span>
                        ) : pricingPreviewMetrics.notFound > 0 ? (
                          <span>
                            (<span className="text-amber-700 font-bold">{pricingPreviewMetrics.notFound}</span> have no matching product and will be skipped).
                          </span>
                        ) : (
                          <span className="text-emerald-700">Every barcode matched an existing product.</span>
                        )}
                        {pricingPreviewMetrics.flagged > 0 && (
                          <span className="text-rose-700 ml-1">{pricingPreviewMetrics.flagged} flagged as loss/break-even.</span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {!pricingMatchCheckDone && (
                        <button
                          onClick={handleCheckPricingMatches}
                          className="text-[10px] text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 px-2 py-1 rounded font-bold cursor-pointer"
                        >
                          Check Matches
                        </button>
                      )}
                      {pricingMatchCheckDone && (
                        <div className="text-right text-[10px] text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded font-bold">
                          {pricingPreviewMetrics.matched} Will Update
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="border border-slate-200 rounded-md max-h-56 overflow-y-auto mb-4 bg-white">
                    <table className="w-full text-[10px] border-collapse">
                      <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-10">
                        <tr className="font-bold text-slate-500 uppercase text-[8px] tracking-wider text-left">
                          <th className="p-2 pl-3">Barcode</th>
                          <th className="p-2">Product</th>
                          <th className="p-2 text-right">Cost</th>
                          <th className="p-2 text-right">Selling</th>
                          <th className="p-2 text-right">GP%</th>
                          <th className="p-2 pr-3 text-center">Flag</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {previewPricingRows.map((r, idx) => {
                          const noMatch = pricingMatchCheckDone && !confirmedExistingBarcodes.has(r.barcode);
                          return (
                            <tr key={idx} className={`hover:bg-slate-50/50 ${noMatch ? "bg-amber-50/30 text-slate-450" : ""}`}>
                              <td className="p-2 pl-3 font-mono text-[9px] font-medium">{r.barcode}</td>
                              <td className="p-2 font-bold text-slate-800">
                                {r.name}
                                {noMatch && (
                                  <span className="ml-1.5 text-[8px] bg-amber-100 text-amber-800 px-1 rounded font-normal">
                                    No Match (Will Skip)
                                  </span>
                                )}
                              </td>
                              <td className="p-2 text-right font-mono text-slate-600">${r.costPrice.toFixed(2)}</td>
                              <td className="p-2 text-right font-mono text-slate-800 font-bold">${r.sellingPrice.toFixed(2)}</td>
                              <td className="p-2 text-right font-mono text-emerald-700">{r.gpPercent.toFixed(1)}%</td>
                              <td className="p-2 pr-3 text-center">
                                {r.pricingFlag === "LOSS_OR_BREAKEVEN" && (
                                  <span className="text-[8px] bg-rose-50 text-rose-700 border border-rose-200 px-1 py-0.5 rounded font-bold">LOSS</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="bg-slate-50 border border-slate-200 rounded p-3 flex flex-col sm:flex-row items-center justify-between gap-3">
                    <div className="text-[10px] text-slate-600 leading-snug">
                      <p className="font-bold text-slate-800">Ready to Patch Existing Products</p>
                      <p>Only costPrice, sellingPrice, margin, gpPercent, markupPercent and pricingFlag are updated — nothing else is touched.</p>
                      {!pricingMatchCheckDone && (
                        <p className="text-amber-700 mt-0.5">Match check will run automatically before applying if skipped.</p>
                      )}
                    </div>
                    <button
                      onClick={handleApplyPricingUpdate}
                      className="w-full sm:w-auto px-4 py-2 bg-indigo-700 hover:bg-indigo-800 text-white text-[11px] font-bold rounded flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                    >
                      <TrendingUp className="h-3.5 w-3.5" />
                      <span>
                        {pricingMatchCheckDone
                          ? `Apply Pricing to ${pricingPreviewMetrics.matched} Products`
                          : `Apply Pricing to ${pricingPreviewMetrics.total} Products`}
                      </span>
                    </button>
                  </div>
                </motion.div>
              )}
            </div>
          )}

          {pricingStatus === "checking" && (
            <div className="py-6 flex flex-col items-center justify-center space-y-3">
              <LoaderIcon className="animate-spin h-7 w-7 text-indigo-600" />
              <div className="text-center">
                <p className="text-[11px] font-bold text-slate-700">Checking which barcodes match existing products...</p>
                <p className="text-[9px] text-slate-400 mt-0.5">Querying in batches of 30 by document ID — no full collection scan.</p>
              </div>
            </div>
          )}

          {pricingStatus === "processing" && (
            <div className="py-6 flex flex-col items-center justify-center space-y-3">
              <LoaderIcon className="animate-spin h-7 w-7 text-indigo-600" />
              <div className="text-center">
                <p className="text-[11px] font-bold text-slate-700">Patching pricing data onto existing products...</p>
                <p className="text-[9px] text-slate-400 mt-0.5">Updating in batches of 500 — stock levels and preferred reps untouched.</p>
              </div>
              <div className="w-full max-w-lg bg-slate-900 text-slate-100 rounded p-2.5 h-32 overflow-y-auto text-left text-[9px] font-mono border border-slate-800 leading-relaxed">
                {pricingLog.map((line, idx) => (
                  <div key={idx} className="opacity-90">
                    <span className="text-indigo-400 font-bold mr-1">&gt;</span>
                    {line}
                  </div>
                ))}
              </div>
            </div>
          )}

          {pricingStatus === "success" && (
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              className="p-4 bg-indigo-50/50 rounded border border-indigo-250 text-center space-y-3"
            >
              <div className="inline-flex items-center justify-center p-2.5 bg-indigo-100 rounded-full text-indigo-600">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-indigo-950">Updated pricing on {pricingStats.updated} products</h3>
                <p className="text-[10px] text-indigo-800 mt-1 leading-snug">
                  {pricingStats.notFound > 0 && `${pricingStats.notFound} barcodes had no matching product and were skipped. `}
                  {pricingStats.failed > 0 && `${pricingStats.failed} updates failed — check console.`}
                </p>
              </div>
              <div className="text-left text-[9px] bg-white p-3 rounded-md max-h-28 overflow-y-auto font-mono text-slate-600 border border-indigo-150">
                {pricingLog.map((l, idx) => (
                  <div key={idx} className="flex gap-1.5 items-start mt-0.5">
                    <span className="text-indigo-600 font-bold">✓</span>
                    <span>{l}</span>
                  </div>
                ))}
              </div>
              <div className="pt-2 flex justify-center gap-2">
                <button
                  onClick={() => {
                    setPricingCsvText("");
                    setPreviewPricingRows([]);
                    setConfirmedExistingBarcodes(new Set());
                    setPricingMatchCheckDone(false);
                    setPricingStatus("idle");
                  }}
                  className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-[10px] font-bold rounded cursor-pointer border border-slate-200"
                >
                  Apply Another CSV
                </button>
                <button
                  onClick={onImportComplete}
                  className="px-3 py-1.5 bg-indigo-700 hover:bg-indigo-800 text-white text-[10px] font-bold rounded cursor-pointer flex items-center gap-1"
                >
                  <span>Verify in Catalog</span>
                  <ArrowRight className="h-3 w-3" />
                </button>
              </div>
            </motion.div>
          )}

          {pricingStatus === "error" && (
            <div className="p-4 bg-rose-50 rounded border border-rose-200 text-center space-y-2.5">
              <div className="inline-flex items-center justify-center p-2 bg-rose-100 rounded-full text-rose-600">
                <AlertCircle className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-rose-900">Pricing Update Failed</h3>
                <p className="text-[10px] text-rose-700 mt-0.5">{pricingErrorDetails}</p>
              </div>
              <button
                onClick={() => setPricingStatus("idle")}
                className="px-3 py-1 bg-slate-800 hover:bg-slate-900 text-white text-[10px] font-semibold rounded cursor-pointer"
              >
                Dismiss &amp; Retry
              </button>
            </div>
          )}
        </>
      )}

      {/* ════════════════════ ADD SINGLE PRODUCT MODE (new) ════════════════════ */}
      {mode === "add-single" && (
        <>
          <p className="text-[11px] text-slate-500 mb-3 leading-relaxed">
            Add one product directly — useful for a barcode that doesn't exist yet (e.g. found on a docket, or a new line not in your last Idealpos export). Pricing is optional; you can add it now or later from the Product Catalog.
          </p>

          {(singleStatus === "idle" || singleStatus === "checking" || singleStatus === "saving" || singleStatus === "error" || singleStatus === "duplicate") && (
            <div className="space-y-3 max-w-lg">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-0.5">
                  <label className="text-[10px] uppercase font-bold text-slate-400">Barcode / SKU *</label>
                  <input
                    type="text"
                    className="w-full text-[11px] font-mono p-2 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    placeholder="e.g. 9421037773919"
                    value={singleBarcode}
                    onChange={(e) => setSingleBarcode(e.target.value)}
                  />
                </div>
                <div className="space-y-0.5">
                  <label className="text-[10px] uppercase font-bold text-slate-400">Category</label>
                  <input
                    type="text"
                    className="w-full text-[11px] p-2 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    placeholder="e.g. 16 or General"
                    value={singleCategory}
                    onChange={(e) => setSingleCategory(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-0.5">
                <label className="text-[10px] uppercase font-bold text-slate-400">Product Name *</label>
                <input
                  type="text"
                  className="w-full text-[11px] font-bold p-2 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  placeholder="e.g. WATTIES SPAGHETTI 3 PACK"
                  value={singleName}
                  onChange={(e) => setSingleName(e.target.value.toUpperCase())}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-0.5">
                  <label className="text-[10px] uppercase font-bold text-slate-400">Cost Price ($) — optional</label>
                  <input
                    type="number" step="0.01" min="0"
                    className="w-full text-[11px] font-mono p-2 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    placeholder="0.00"
                    value={singleCostPrice}
                    onChange={(e) => setSingleCostPrice(e.target.value)}
                  />
                </div>
                <div className="space-y-0.5">
                  <label className="text-[10px] uppercase font-bold text-slate-400">Selling Price ($) — optional</label>
                  <input
                    type="number" step="0.01" min="0"
                    className="w-full text-[11px] font-mono p-2 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    placeholder="0.00"
                    value={singleSellingPrice}
                    onChange={(e) => setSingleSellingPrice(e.target.value)}
                  />
                </div>
              </div>

              {(singleCostPrice || singleSellingPrice) && (
                singlePricingPreview ? (
                  <div className={`p-2 rounded border text-[10px] ${
                    singlePricingPreview.pricingFlag === "LOSS_OR_BREAKEVEN" ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-emerald-50 border-emerald-200 text-emerald-800"
                  }`}>
                    <span className="font-bold">Margin ${singlePricingPreview.margin.toFixed(2)}</span>
                    <span className="mx-1.5">·</span>
                    <span className="font-bold">GP {singlePricingPreview.gpPercent.toFixed(1)}%</span>
                    <span className="mx-1.5">·</span>
                    <span>Markup {singlePricingPreview.markupPercent.toFixed(1)}%</span>
                    {singlePricingPreview.pricingFlag === "LOSS_OR_BREAKEVEN" && (
                      <span className="ml-1.5 font-bold">— cost ≥ selling, will be flagged</span>
                    )}
                  </div>
                ) : (
                  <p className="text-[9px] text-amber-700 italic">Both Cost Price and Selling Price need a valid value above $0 for pricing to be saved — leave both blank to add the product without pricing.</p>
                )
              )}

              {singleStatus === "error" && singleErrorDetails && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 text-[10px] rounded-lg leading-tight font-medium flex items-start gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>{singleErrorDetails}</span>
                </div>
              )}

              {singleStatus === "duplicate" && singleErrorDetails && (
                <div className="p-2.5 bg-amber-50 border border-amber-200 text-amber-800 text-[10px] rounded-lg leading-tight font-medium flex items-start gap-1.5">
                  <Search className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>{singleErrorDetails}</span>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={resetSingleForm}
                  disabled={singleStatus === "checking" || singleStatus === "saving"}
                  className="px-3 py-1.5 border border-slate-200 hover:bg-slate-50 text-slate-600 text-[11px] font-semibold rounded cursor-pointer disabled:opacity-50"
                >
                  Clear
                </button>
                <button
                  onClick={handleSaveSingleProduct}
                  disabled={singleStatus === "checking" || singleStatus === "saving"}
                  className="px-4 py-1.5 bg-emerald-700 hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-400 text-white text-[11px] font-bold rounded cursor-pointer flex items-center gap-1.5"
                >
                  {(singleStatus === "checking" || singleStatus === "saving") ? (
                    <>
                      <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
                      <span>{singleStatus === "checking" ? "Checking barcode..." : "Saving..."}</span>
                    </>
                  ) : (
                    <>
                      <PlusCircle className="h-3.5 w-3.5" />
                      <span>Add Product</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {singleStatus === "success" && (
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              className="p-4 bg-emerald-50/50 rounded border border-emerald-250 text-center space-y-3 max-w-lg"
            >
              <div className="inline-flex items-center justify-center p-2.5 bg-emerald-100 rounded-full text-emerald-600">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-emerald-950">Added "{singleSavedName}"</h3>
                <p className="text-[10px] text-emerald-800 mt-1 leading-snug">The product is now searchable in the Product Catalog.</p>
              </div>
              <div className="pt-2 flex justify-center gap-2">
                <button
                  onClick={resetSingleForm}
                  className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-[10px] font-bold rounded cursor-pointer border border-slate-200"
                >
                  Add Another
                </button>
                <button
                  onClick={onImportComplete}
                  className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-[10px] font-bold rounded cursor-pointer flex items-center gap-1"
                >
                  <span>Verify in Catalog</span>
                  <ArrowRight className="h-3 w-3" />
                </button>
              </div>
            </motion.div>
          )}
        </>
      )}
    </div>
  );
}