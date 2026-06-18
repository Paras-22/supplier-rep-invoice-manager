import React, { useState } from "react";
import { FileUp, Receipt, Check, Loader2, AlertCircle, ShoppingBag, UserCheck, Plus, Sparkles, RefreshCw, Edit2 } from "lucide-react";
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

const callGemini = async (prompt: string, imagePart?: { mime_type: string; data: string }) => {
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
    const err = await response.json();
    throw new Error(err?.error?.message || "Gemini API call failed");
  }
  const data = await response.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return raw.replace(/```json|```/g, "").trim();
};

export default function DocketScanner({ reps, onScanConfirmed, currentUserUid }: DocketScannerProps) {
  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "scanning" | "matching" | "review" | "saving" | "success" | "error">("idle");
  const [matchingProgress, setMatchingProgress] = useState("");

  const [extractedData, setExtractedData] = useState<{
    supplierName: string;
    repName: string | null;
    invoiceDate: string;
    totalAmount: number;
    items: InvoiceItem[];
  } | null>(null);

  const [selectedRepId, setSelectedRepId] = useState<string>("");
  const [invoiceRecordId, setInvoiceRecordId] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState("");

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
    if (e.dataTransfer.files?.[0]) handleFileSelected(e.dataTransfer.files[0]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) handleFileSelected(e.target.files[0]);
  };

  const handleFileSelected = (selectedFile: File) => {
    const validMimes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (!validMimes.includes(selectedFile.type)) {
      setStatus("error");
      setErrorMessage("Unsupported file type. Please upload a Photo (JPEG/PNG) or a PDF docket.");
      return;
    }
    setFile(selectedFile);
    setStatus("idle");
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

  const findOrCreateRep = async (supplierName: string, repName: string | null): Promise<string> => {
    const existingRep = reps.find(r =>
      r.company.toLowerCase().includes(supplierName.toLowerCase()) ||
      supplierName.toLowerCase().includes(r.company.toLowerCase())
    );
    if (existingRep) return existingRep.id;

    const repRef = doc(collection(db, "reps"));
    await setDoc(repRef, {
      id: repRef.id,
      name: repName || supplierName,
      company: supplierName,
      createdAt: serverTimestamp()
    });
    return repRef.id;
  };

  const handleStartOCRScan = async () => {
    if (!file) { setStatus("error"); setErrorMessage("Please select a file to scan."); return; }
    if (!GEMINI_API_KEY) { setStatus("error"); setErrorMessage("Gemini API key not found. Add VITE_GEMINI_API_KEY to your .env file."); return; }

    setStatus("scanning");
    try {
      const { base64, mimeType } = await convertFileToBase64(file);

      // ── STEP 1: OCR — extract docket data ──────────────────────────────
      const ocrPrompt = `You are an expert invoice analyzer for a New Zealand supermarket.
Analyze this supplier docket/invoice carefully.

Extract and return ONLY a valid JSON object with no markdown, no explanation:
{
  "supplierName": "full company name on the docket",
  "repName": "sales rep name if visible, otherwise null",
  "invoiceDate": "date in YYYY-MM-DD format, or null",
  "totalAmount": total invoice amount as number or 0,
  "items": [
    {
      "name": "full expanded standardised product name in UPPERCASE English",
      "code": "supplier product code if visible, otherwise null",
      "quantity": quantity ordered as whole number,
      "price": unit price as decimal number
    }
  ]
}

Critical rules:
- ALL product names in UPPERCASE
- Expand ALL abbreviations: Msshi→MUSASHI, Shrd→SHREDDED, Enrgy→ENERGY, Rasp→RASPBERRY, Lm→LEMON, P/Fruit→PASSIONFRUIT, Choc→CHOCOLATE, Straw→STRAWBERRY, Van→VANILLA, B/B→BIG BANG
- Include: Brand + Product Type + Size/Volume + Flavour
- Remove pack multipliers (x12, x24, 12pk, per carton) from name
- Numbers in brackets (24) (12) = carton size, remove from name
- Keep product size like 375ML, 500ML, 130G in name
- price = UNIT PRICE column value
- quantity = QTY column value as integer
- Return only JSON, nothing else`;

      const ocrRaw = await callGemini(ocrPrompt, { mime_type: mimeType, data: base64 });
      const ocrPayload = JSON.parse(ocrRaw);

      // ── STEP 2: SMART MATCHING — minimal Firestore reads ───────────────
      setStatus("matching");
      setMatchingProgress("Collecting unique search terms...");

      const items: any[] = ocrPayload.items || [];

      // Collect all unique first words across ALL docket items — deduped
      const firstWords = new Set<string>();
      const codes = new Set<string>();

      items.forEach((item: any) => {
        const nameUpper = (item.name || "").toUpperCase();
        const firstWord = nameUpper.split(" ")[0];
        if (firstWord && firstWord.length > 2) firstWords.add(firstWord);
        if (item.code && item.code !== "null") codes.add(item.code);
      });

      setMatchingProgress(`Searching database for ${firstWords.size} unique brands...`);

      // ONE batch query per unique first word — fetch all candidates at once
      const candidateMap: Map<string, { id: string; name: string; sku: string }> = new Map();

      // Fetch by first word (brand name) — covers most products
      const wordQueries = Array.from(firstWords).map(word =>
        getDocs(query(
          collection(db, "products"),
          where("name", ">=", word),
          where("name", "<=", word + "\uf8ff"),
          limit(15)
        ))
      );

      // Fetch by supplier code
      const codeQueries = Array.from(codes).map(code =>
        getDocs(query(
          collection(db, "products"),
          where("sku", "==", code),
          limit(1)
        ))
      );

      // Run ALL queries in parallel
      const [wordResults, codeResults] = await Promise.all([
        Promise.all(wordQueries),
        Promise.all(codeQueries)
      ]);

      // Build candidate map in memory — zero more Firestore reads after this
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
      setMatchingProgress(`Found ${allCandidates.length} candidates. Asking Gemini to match...`);

      // ── STEP 3: ONE Gemini call to match ALL products at once ──────────
      const matchPrompt = `You are a product matching assistant for a New Zealand supermarket.

Match each docket product to the best database candidate IN MEMORY — no more database calls needed.

Docket products to match:
${items.map((item: any, i: number) => `${i + 1}. "${item.name}" (code: ${item.code || "none"})`).join("\n")}

Database candidates available:
${allCandidates.map(c => `- ID: ${c.id} | Name: ${c.name} | SKU: ${c.sku}`).join("\n")}

Matching rules:
- Match by brand + product type + size/volume + flavour
- Word order differences are OK (MUSASHI ENERGY MANGO 500ML = MUSASHI 500ML MANGO)
- Size must match (500ML ≠ 375ML)
- Flavour must match (MANGO ≠ PINEAPPLE)
- If supplier code matches SKU exactly — that is a definitive match
- If no reasonable match exists — use null
- Do NOT force a wrong match

Return ONLY a JSON array, no markdown:
[
  {"productIndex": 1, "matchedId": "barcode_id_or_null", "confidence": "high/medium/low/none"},
  {"productIndex": 2, "matchedId": "barcode_id_or_null", "confidence": "high/medium/low/none"}
]`;

      const matchRaw = await callGemini(matchPrompt);
      let matchResults: { productIndex: number; matchedId: string | null; confidence: string }[] = [];
      try {
        matchResults = JSON.parse(matchRaw);
      } catch {
        console.error("Match parse error:", matchRaw);
        matchResults = [];
      }

      // Build final items — only accept high/medium confidence matches
      const matchedItems: InvoiceItem[] = items.map((item: any, index: number) => {
        const match = matchResults.find((r: any) => r.productIndex === index + 1);
        const acceptMatch = match?.matchedId && match.confidence !== "low" && match.confidence !== "none";
        const candidate = acceptMatch ? candidateMap.get(match!.matchedId!) : null;

        return {
          name: item.name,
          code: item.code || null,
          quantity: item.quantity || 1,
          price: item.price || 0,
          matchedProductId: acceptMatch ? match!.matchedId! : "",
          matchedProductName: candidate?.name || ""
        };
      });

      // ── STEP 4: Find or create rep ─────────────────────────────────────
      const repId = await findOrCreateRep(
        ocrPayload.supplierName || "Unknown Supplier",
        ocrPayload.repName
      );
      setSelectedRepId(repId);

      setExtractedData({
        supplierName: ocrPayload.supplierName || "Unknown Supplier",
        repName: ocrPayload.repName || null,
        invoiceDate: ocrPayload.invoiceDate || new Date().toISOString().split("T")[0],
        totalAmount: ocrPayload.totalAmount || 0,
        items: matchedItems
      });

      // Save pending invoice draft
      const invoiceRef = doc(collection(db, "invoices"));
      await setDoc(invoiceRef, {
        id: invoiceRef.id,
        fileUrl: "frontend-upload",
        fileName: file.name,
        repId,
        repName: ocrPayload.repName || ocrPayload.supplierName,
        invoiceDate: ocrPayload.invoiceDate || new Date().toISOString().split("T")[0],
        totalAmount: ocrPayload.totalAmount || 0,
        status: "pending_review",
        items: matchedItems,
        createdAt: serverTimestamp(),
        createdBy: currentUserUid
      } as Invoice);
      setInvoiceRecordId(invoiceRef.id);
      setStatus("review");

    } catch (err: any) {
      console.error("Scanning failed:", err);
      setStatus("error");
      setErrorMessage(err.message || "Failed to scan docket. Check your Gemini API key.");
    }
  };

  const handleUpdateItemField = (index: number, field: keyof InvoiceItem, value: any) => {
    if (!extractedData) return;
    const itemsCopy = [...extractedData.items];
    itemsCopy[index] = { ...itemsCopy[index], [field]: value };
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

        const priceRef = doc(collection(db, "prices"));
        await setDoc(priceRef, {
          id: priceRef.id,
          productId,
          repId: selectedRepId,
          price: item.price,
          packSize: `Qty ${item.quantity}`,
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
          <span>Gemini 2.5 Flash — 2 API calls per docket</span>
        </div>
      </div>

      {/* IDLE */}
      {status === "idle" && (
        <div className="space-y-3">
          {!file ? (
            <div
              onDragEnter={handleDrag} onDragOver={handleDrag}
              onDragLeave={handleDrag} onDrop={handleDrop}
              onClick={() => document.getElementById("docket_file_picker")?.click()}
              className={`border-2 border-dashed rounded p-8 flex flex-col items-center justify-center cursor-pointer transition-all ${
                dragActive ? "border-emerald-500 bg-emerald-50/30" : "border-slate-200 hover:border-emerald-400 bg-slate-50/40"
              }`}
            >
              <FileUp className="h-8 w-8 text-slate-400 mb-2" />
              <p className="text-xs font-bold text-slate-700">Upload Wholesale Docket Photo or PDF</p>
              <p className="text-[10px] text-slate-400 mt-0.5">Drag and drop or click to browse</p>
              <p className="text-[9px] text-slate-400 mt-2">Accepts PDF, JPG, PNG, WEBP</p>
              <input type="file" id="docket_file_picker" className="hidden" accept="image/*,application/pdf" onChange={handleFileChange} />
            </div>
          ) : (
            <div className="flex items-center justify-between p-2.5 bg-emerald-50/50 rounded border border-emerald-100">
              <div className="flex items-center gap-2">
                <Receipt className="h-6 w-6 text-emerald-600 shrink-0" />
                <div>
                  <p className="text-[11px] font-bold text-slate-800 line-clamp-1">{file.name}</p>
                  <p className="text-[9px] text-slate-500">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => setFile(null)} className="px-2 py-1 text-[10px] font-semibold text-slate-500 hover:text-slate-700 cursor-pointer">Clear</button>
                <button onClick={handleStartOCRScan} className="px-2.5 py-1 text-[10px] font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded cursor-pointer flex items-center gap-1">
                  <Sparkles className="h-3 w-3" />
                  <span>Start Gemini Scan</span>
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
            <h3 className="text-xs font-bold text-slate-800">Gemini reading your docket...</h3>
            <p className="text-[10px] text-slate-400 mt-0.5">Extracting supplier, products, quantities and prices.</p>
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
            <p className="text-[9px] text-slate-300 mt-1">Minimal database reads — matching in memory</p>
          </div>
        </div>
      )}

      {/* REVIEW */}
      {status === "review" && extractedData && (
        <div className="space-y-3 text-left">
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
              <table className="w-full text-left text-[10px]">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 font-bold uppercase text-[8px] border-b border-slate-200">
                    <th className="p-1 px-2.5">Database Match</th>
                    <th className="p-1 px-2.5">Product Name (from docket)</th>
                    <th className="p-1 px-2 w-24">Barcode / Code</th>
                    <th className="p-1 px-2 w-12 text-center">Qty</th>
                    <th className="p-1 px-2 w-20">Unit Price ($)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {extractedData.items.map((item, index) => (
                    <tr key={index} className={`hover:bg-slate-50/50 ${item.matchedProductId ? "" : "bg-amber-50/30"}`}>

                      {/* DATABASE MATCH COLUMN */}
                      <td className="p-1 px-2 min-w-[160px]">
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
                      <td className="p-1 px-2">
                        <input type="text" className="bg-transparent border-b border-transparent hover:border-slate-300 focus:border-emerald-500 focus:outline-none p-0 text-[10px] font-bold text-slate-800 w-full" value={item.name} onChange={(e) => handleUpdateItemField(index, "name", e.target.value)} />
                      </td>

                      {/* BARCODE / CODE */}
                      <td className="p-1 px-2">
                        <input type="text" className="bg-transparent border-b border-transparent hover:border-slate-300 focus:border-emerald-500 focus:outline-none p-0 text-[9px] font-mono text-slate-400 w-full" value={item.code || ""} onChange={(e) => handleUpdateItemField(index, "code", e.target.value)} placeholder="N/A" />
                      </td>

                      {/* QTY */}
                      <td className="p-1 px-2 text-center">
                        <input type="number" className="bg-transparent border-b border-transparent hover:border-slate-300 focus:border-emerald-500 focus:outline-none p-0 text-[10px] text-slate-800 w-full text-center font-bold" value={item.quantity} onChange={(e) => handleUpdateItemField(index, "quantity", parseInt(e.target.value) || 0)} />
                      </td>

                      {/* UNIT PRICE */}
                      <td className="p-1 px-2">
                        <div className="relative">
                          <span className="absolute left-0 bottom-0 text-[9px] text-slate-400">$</span>
                          <input type="number" step="0.01" className="bg-transparent border-b border-transparent hover:border-slate-300 focus:border-emerald-500 focus:outline-none p-0 pl-2.5 text-[10px] w-full font-bold text-slate-800" value={item.price} onChange={(e) => handleUpdateItemField(index, "price", parseFloat(e.target.value) || 0)} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
            onClick={() => { setFile(null); setExtractedData(null); setStatus("idle"); setMatchingProgress(""); onScanConfirmed(); }}
            className="px-3 py-1 bg-slate-900 hover:bg-slate-800 text-white text-[10px] font-semibold rounded cursor-pointer"
          >
            Scan Another Docket
          </button>
        </motion.div>
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