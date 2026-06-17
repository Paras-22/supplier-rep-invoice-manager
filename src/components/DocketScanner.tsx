import React, { useState } from "react";
import { FileUp, Receipt, Check, Loader2, AlertCircle, ShoppingBag, UserCheck, Plus, Sparkles, RefreshCw } from "lucide-react";
import { collection, doc, setDoc, updateDoc, serverTimestamp, query, where, getDocs, limit } from "firebase/firestore";
import { db, handleFirestoreError, OperationType } from "../firebase";
import { Rep, Product, Invoice, InvoiceItem } from "../types";
import { motion } from "motion/react";

interface DocketScannerProps {
  reps: Rep[];
  products: Product[];
  onScanConfirmed: () => void;
  currentUserUid: string;
}

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

export default function DocketScanner({ reps, onScanConfirmed, currentUserUid }: DocketScannerProps) {
  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "scanning" | "matching" | "review" | "saving" | "success" | "error">("idle");

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
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFileSelected(e.dataTransfer.files[0]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) handleFileSelected(e.target.files[0]);
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

  const convertFileToBase64 = (selectedFile: File): Promise<{ base64: string; mimeType: string }> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(selectedFile);
      reader.onload = () => {
        const result = reader.result as string;
        const base64Str = result.substring(result.indexOf(",") + 1);
        resolve({ base64: base64Str, mimeType: selectedFile.type });
      };
      reader.onerror = (err) => reject(err);
    });
  };

  // Step 1 — Call Gemini to extract docket data
  const callGeminiOCR = async (base64: string, mimeType: string) => {
const prompt = `You are an expert invoice analyzer for a New Zealand supermarket.
Analyze this supplier docket/invoice carefully.

Extract and return ONLY a valid JSON object with no markdown, no explanation:
{
  "supplierName": "full company name on the docket",
  "repName": "sales rep name if visible, otherwise null",
  "invoiceDate": "date in YYYY-MM-DD format, or null",
  "totalAmount": total invoice amount as number or 0,
  "items": [
    {
      "name": "full expanded standardised product name in UPPERCASE",
      "code": "supplier product code if visible, otherwise null",
      "quantity": number of units/cartons ordered as integer,
      "price": unit price as number
    }
  ]
}

Critical rules for product names:
- Always write product names in UPPERCASE
- EXPAND all abbreviations:
  * "B/B" → "BIG BANG" or keep as brand name
  * Numbers in brackets like "(24)" or "(12)" = pack size, include as part of name
  * "Msshi" or "Mssh" → "MUSASHI"
  * "Shrd" → "SHREDDED"  
  * "Enrgy" → "ENERGY"
  * "Rasp/Lm" → "RASPBERRY LEMON"
  * "P/Fruit" → "PASSIONFRUIT"
  * Any abbreviation → expand to full English word
- Include: Brand + Product Type + Size/Volume + Flavour
- Remove pack quantity multipliers like "x12", "x24", "12pk" from the name
- Examples:
  * "MUSASHI ENERGY 500ML (12) MANGO" → "MUSASHI ENERGY 500ML MANGO"
  * "kobi salted peanuts 130gx24ctn" → "KOBI SALTED PEANUTS 130G"
  * "Colgate175gmx12 Regular (Blue)" → "COLGATE TOOTHPASTE 175G REGULAR"
  * "B/B 375ML GUAVA (24)" → "BIG BANG 375ML GUAVA"
  * "KITKAT CHUNKY HAZEL NUTTY (24)" → "KITKAT CHUNKY HAZELNUT"
- For the price field: use the UNIT PRICE column value
- For the quantity field: use the QTY column value as integer
- Return only the JSON, nothing else`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mimeType, data: base64 } },
              { text: prompt }
            ]
          }],
          generationConfig: { temperature: 0.1 }
        })
      }
    );

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err?.error?.message || "Gemini API call failed");
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  };

  // Step 3 — Auto create rep if not exists
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
    if (!file) {
      setStatus("error");
      setErrorMessage("Please select a file to scan.");
      return;
    }

    if (!GEMINI_API_KEY) {
      setStatus("error");
      setErrorMessage("Gemini API key not found. Add VITE_GEMINI_API_KEY to your .env file.");
      return;
    }

    setStatus("scanning");
    try {
      const { base64, mimeType } = await convertFileToBase64(file);

      // Step 1 — Extract docket data with Gemini
      const ocrPayload = await callGeminiOCR(base64, mimeType);

      setStatus("matching");

      // Step 2 — Batch fetch candidates for all products
      const allCandidates: {
        itemIndex: number;
        itemName: string;
        candidates: { id: string; name: string }[];
      }[] = [];

      for (let i = 0; i < ocrPayload.items.length; i++) {
        const item = ocrPayload.items[i];
        const nameUpper = (item.name || "").toUpperCase();
        const firstWord = nameUpper.split(" ")[0];

        // Try exact name match first
        const exactSnap = await getDocs(
          query(collection(db, "products"), where("name", "==", nameUpper), limit(1))
        );
        if (!exactSnap.empty) {
          allCandidates.push({
            itemIndex: i,
            itemName: item.name,
            candidates: [{ id: exactSnap.docs[0].id, name: exactSnap.docs[0].data().name }]
          });
          continue;
        }

        // Try code match
        if (item.code) {
          const codeSnap = await getDocs(
            query(collection(db, "products"), where("sku", "==", item.code), limit(1))
          );
          if (!codeSnap.empty) {
            allCandidates.push({
              itemIndex: i,
              itemName: item.name,
              candidates: [{ id: codeSnap.docs[0].id, name: codeSnap.docs[0].data().name }]
            });
            continue;
          }
        }

        // Get broad candidates by first word
        if (firstWord && firstWord.length > 2) {
          const broadSnap = await getDocs(
            query(
              collection(db, "products"),
              where("name", ">=", firstWord),
              where("name", "<=", firstWord + "\uf8ff"),
              limit(10)
            )
          );
          allCandidates.push({
            itemIndex: i,
            itemName: item.name,
            candidates: broadSnap.docs.map(d => ({
              id: d.id,
              name: d.data().name || ""
            }))
          });
        } else {
          allCandidates.push({
            itemIndex: i,
            itemName: item.name,
            candidates: []
          });
        }
      }

      // Single Gemini batch call to match ALL products at once
      const batchMatchPrompt = `You are a product matching assistant for a New Zealand supermarket.

Below are products from a supplier docket with possible database matches.
Match each docket product to the best database candidate.

Products:
${allCandidates.map((c, i) => `
Product ${i + 1}: "${c.itemName}"
Candidates:
${c.candidates.length > 0
  ? c.candidates.map(cand => `  - ID: ${cand.id} | Name: ${cand.name}`).join("\n")
  : "  No candidates found"
}`).join("\n")}

Rules:
- Match based on similarity — same brand, product type, size
- Word order differences are OK
- If no candidate is a reasonable match use null
- Return ONLY a JSON array, no markdown, no explanation:
[
  {"productIndex": 1, "matchedId": "id_or_null"},
  {"productIndex": 2, "matchedId": "id_or_null"}
]`;

      const batchResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: batchMatchPrompt }] }],
            generationConfig: { temperature: 0 }
          })
        }
      );

      const batchData = await batchResponse.json();
      const batchRaw = batchData?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
      const batchCleaned = batchRaw.replace(/```json|```/g, "").trim();

      let matchResults: { productIndex: number; matchedId: string | null }[] = [];
      try {
        matchResults = JSON.parse(batchCleaned);
      } catch {
        console.error("Batch match parse error:", batchCleaned);
        matchResults = [];
      }

      // Build final matched items
      const matchedItems: InvoiceItem[] = ocrPayload.items.map((item: any, index: number) => {
        const match = matchResults.find((r: any) => r.productIndex === index + 1);
        return {
          name: item.name,
          code: item.code || null,
          quantity: item.quantity || 1,
          price: item.price || 0,
          matchedProductId: match?.matchedId || ""
        };
      });

      // Step 3 — Find or create rep
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
      const invoiceDraft: Invoice = {
        id: invoiceRef.id,
        fileUrl: "frontend-upload",
        fileName: file.name,
        repId: repId,
        repName: ocrPayload.repName || ocrPayload.supplierName,
        invoiceDate: ocrPayload.invoiceDate || new Date().toISOString().split("T")[0],
        totalAmount: ocrPayload.totalAmount || 0,
        status: "pending_review",
        items: matchedItems,
        createdAt: serverTimestamp(),
        createdBy: currentUserUid
      };
      await setDoc(invoiceRef, invoiceDraft);
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
    const prodRef = doc(db, "products", newId);
    try {
      await setDoc(prodRef, {
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
          <span>Gemini 2.5 Flash Active</span>
        </div>
      </div>

      {/* IDLE */}
      {status === "idle" && (
        <div className="space-y-3">
          {!file ? (
            <div
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
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
                <button onClick={() => setFile(null)} className="px-2 py-1 text-[10px] font-semibold text-slate-500 hover:text-slate-700 cursor-pointer">
                  Clear
                </button>
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
            <p className="text-[10px] text-slate-400 mt-0.5">Batch matching all products in one call.</p>
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
              <p className="text-[9px] text-slate-400">
                {extractedData.items.filter(i => i.matchedProductId).length}/{extractedData.items.length} matched to database
              </p>
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded">
              <table className="w-full text-left text-[10px]">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 font-bold uppercase text-[8px] border-b border-slate-200">
                    <th className="p-1 px-2.5">Database Match</th>
                    <th className="p-1 px-2.5">Product Name (from docket)</th>
                    <th className="p-1 px-2 w-24">Code</th>
                    <th className="p-1 px-2 w-12 text-center">Qty</th>
                    <th className="p-1 px-2 w-20">Unit Price ($)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {extractedData.items.map((item, index) => (
                    <tr key={index} className="hover:bg-slate-50/50">
                      <td className="p-1 px-2">
                        {item.matchedProductId ? (
                          <div className="flex items-center gap-1 px-1.5 py-0.5 bg-emerald-50 text-emerald-800 rounded font-bold text-[9px] w-fit">
                            <Check className="h-3 w-3 shrink-0" />
                            <span className="line-clamp-1 max-w-[120px]">{item.matchedProductId}</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1">
                            <span className="text-[9px] text-amber-700 bg-amber-50 px-1 rounded">No match</span>
                            <button
                              onClick={() => handleCreateNewProduct(index)}
                              title="Create new product"
                              className="p-0.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded cursor-pointer"
                            >
                              <Plus className="h-3 w-3 text-emerald-600" />
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="p-1 px-2">
                        <input type="text" className="bg-transparent border-b border-transparent hover:border-slate-300 focus:border-emerald-500 focus:outline-none p-0 text-[10px] font-bold text-slate-800 w-full" value={item.name} onChange={(e) => handleUpdateItemField(index, "name", e.target.value)} />
                      </td>
                      <td className="p-1 px-2">
                        <input type="text" className="bg-transparent border-b border-transparent hover:border-slate-300 focus:border-emerald-500 focus:outline-none p-0 text-[9px] font-mono text-slate-400 w-full" value={item.code || ""} onChange={(e) => handleUpdateItemField(index, "code", e.target.value)} placeholder="N/A" />
                      </td>
                      <td className="p-1 px-2 text-center">
                        <input type="number" className="bg-transparent border-b border-transparent hover:border-slate-300 focus:border-emerald-500 focus:outline-none p-0 text-[10px] text-slate-800 w-full text-center font-bold" value={item.quantity} onChange={(e) => handleUpdateItemField(index, "quantity", parseInt(e.target.value) || 0)} />
                      </td>
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

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
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
            onClick={() => { setFile(null); setExtractedData(null); setStatus("idle"); onScanConfirmed(); }}
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