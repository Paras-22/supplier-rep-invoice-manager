import React, { useState, useMemo } from "react";
import { Upload, FileText, CheckCircle2, AlertCircle, Info, Loader2 as LoaderIcon, Database, ArrowRight } from "lucide-react";
import { doc, writeBatch, serverTimestamp, collection, query, where, documentId, getDocs } from "firebase/firestore";
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

export default function POSImport({ onImportComplete }: POSImportProps) {
  const [csvText, setCsvText] = useState("");
  const [previewProducts, setPreviewProducts] = useState<PreviewProduct[]>([]);
  const [status, setStatus] = useState<"idle" | "parsed" | "checking" | "processing" | "success" | "error">("idle");
  const [log, setLog] = useState<string[]>([]);
  const [errorDetails, setErrorDetails] = useState("");
  const [importStats, setImportStats] = useState({ saved: 0, skippedDuplicates: 0, failed: 0 });
  // Set of IDs (from previewProducts) confirmed to already exist in Firestore.
  // Populated by checkExistingIds() right before import, and used to render
  // accurate "Duplicate" badges in the preview table.
  const [confirmedDuplicateIds, setConfirmedDuplicateIds] = useState<Set<string>>(new Set());
  const [duplicateCheckDone, setDuplicateCheckDone] = useState(false);

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

  return (
    <div className="bg-white rounded-md shadow-xs border border-slate-250 p-4">
      <div className="flex items-center gap-1.5 mb-2.5">
        <FileText className="h-4 w-4 text-emerald-600" />
        <h2 className="text-sm font-bold text-slate-900">Idealpos CSV Product Import</h2>
      </div>

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
    </div>
  );
}