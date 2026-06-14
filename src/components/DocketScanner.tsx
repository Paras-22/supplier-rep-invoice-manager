import React, { useState } from "react";
import { FileUp, Receipt, Check, Loader2, AlertCircle, ShoppingBag, UserCheck, Plus, Sparkles, RefreshCw } from "lucide-react";
import { collection, doc, addDoc, getDoc, setDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db, handleFirestoreError, OperationType } from "../firebase";
import { Rep, Product, PriceEntry, Invoice, InvoiceItem } from "../types";
import { motion } from "motion/react";

interface DocketScannerProps {
  reps: Rep[];
  products: Product[];
  onScanConfirmed: () => void;
  currentUserUid: string;
}

export default function DocketScanner({ reps, products, onScanConfirmed, currentUserUid }: DocketScannerProps) {
  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "scanning" | "review" | "saving" | "success" | "error">("idle");
  
  // OCR Extracted state
  const [extractedData, setExtractedData] = useState<{
    supplierName: string;
    invoiceDate: string;
    repName: string | null;
    totalAmount: number;
    items: InvoiceItem[];
  } | null>(null);

  const [selectedRepId, setSelectedRepId] = useState<string>("");
  const [invoiceRecordId, setInvoiceRecordId] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState("");

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFileSelected(e.target.files[0]);
    }
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
        const commaIdx = result.indexOf(",");
        const base64Str = result.substring(commaIdx + 1);
        resolve({ base64: base64Str, mimeType: selectedFile.type });
      };
      reader.onerror = (err) => reject(err);
    });
  };

  const handleStartOCRScan = async () => {
    if (!file) {
      setStatus("error");
      setErrorMessage("Please select a file to scan.");
      return;
    }

    setStatus("scanning");
    try {
      const { base64, mimeType } = await convertFileToBase64(file);

      // Call our server-side proxy endpoint
      const response = await fetch("/api/scan-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileData: base64, mimeType })
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || "Failed to parse docket using Gemini 3.5 Flash.");
      }

      const resData = await response.json();
      if (!resData.success || !resData.data) {
        throw new Error("No structured docket data returned from server proxy.");
      }

      // Populate extracted OCR payload
      const ocrPayload = resData.data;
      
      // Auto-match items against existing inventory
      const checkedItems = ocrPayload.items.map((item: any) => {
        // Simple scan lookup
        const codeMatch = products.find(p => p.id === item.code || p.sku === item.code);
        if (codeMatch) {
          return { ...item, matchedProductId: codeMatch.id };
        }
        
        // Soft name lookup (case insensitive match)
        const nameMatch = products.find(p => p.name.toLowerCase() === item.name.toLowerCase());
        if (nameMatch) {
          return { ...item, matchedProductId: nameMatch.id };
        }

        // Substring name lookup
        const subNameMatch = products.find(p => 
          item.name.toLowerCase().includes(p.name.toLowerCase()) || 
          p.name.toLowerCase().includes(item.name.toLowerCase())
        );
        if (subNameMatch) {
          return { ...item, matchedProductId: subNameMatch.id };
        }

        return { ...item, matchedProductId: "" }; // default: none, needs creation or manual map
      });

      setExtractedData({
        supplierName: ocrPayload.supplierName || "Unknown Supplier LLC",
        invoiceDate: ocrPayload.invoiceDate || new Date().toISOString().split("T")[0],
        repName: ocrPayload.repName || null,
        totalAmount: ocrPayload.totalAmount || 0,
        items: checkedItems
      });

      // Attempt to auto-detect matching rep based on supplier company name
      const foundRep = reps.find(r => 
        r.company.toLowerCase().includes(ocrPayload.supplierName.toLowerCase()) ||
        ocrPayload.supplierName.toLowerCase().includes(r.company.toLowerCase()) ||
        (ocrPayload.repName && r.name.toLowerCase().includes(ocrPayload.repName.toLowerCase()))
      );

      if (foundRep) {
        setSelectedRepId(foundRep.id);
      } else if (reps.length > 0) {
        setSelectedRepId(reps[0].id); // default to first rep
      }

      // Create a pending review document draft in invoices
      const invoiceRef = doc(collection(db, "invoices"));
      const invoiceDraft: Invoice = {
        id: invoiceRef.id,
        fileUrl: "Local Scan Image Base64 Data",
        fileName: file.name,
        repId: foundRep ? foundRep.id : "",
        repName: ocrPayload.repName || "",
        invoiceDate: ocrPayload.invoiceDate || new Date().toISOString().split("T")[0],
        totalAmount: ocrPayload.totalAmount || 0,
        status: "pending_review",
        items: checkedItems,
        createdAt: serverTimestamp(),
        createdBy: currentUserUid
      };

      await setDoc(invoiceRef, invoiceDraft);
      setInvoiceRecordId(invoiceRef.id);
      setStatus("review");

    } catch (err: any) {
      console.error("Scanning failed: ", err);
      setStatus("error");
      setErrorMessage(err.message || "Failed to scan docket with Gemini 3.5. Ensure server is online.");
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
    
    // Create random sanitised code if missing
    const newId = item.code ? item.code.replace(/[^a-zA-Z0-9_\-\+\.]/g, "") : `MAPPED_${Math.floor(Date.now() / 1000)}_${index}`;
    
    const prodRef = doc(db, "products", newId);
    const newProduct: Product = {
      id: newId,
      name: item.name,
      sku: newId,
      category: "Dockets Extracted",
      lowStock: false,
      preferredRepId: selectedRepId || null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    try {
      await setDoc(prodRef, newProduct);
      handleUpdateItemField(index, "matchedProductId", newId);
      // Alerts product catalogs
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `products/${newId}`);
    }
  };

  const handleConfirmReviewSubmit = async () => {
    if (!extractedData || !invoiceRecordId) return;

    if (!selectedRepId) {
      setStatus("error");
      setErrorMessage("Please select or create a Supplier Representative before submitting price logs.");
      return;
    }

    setStatus("saving");

    try {
      // Loop through reviewed items and write prices history
      for (const item of extractedData.items) {
        if (!item.matchedProductId) {
          // If product matches none and manager didn't select or create one, create it implicitly
          const fallbackId = `AUTO_POS_${Math.floor(Date.now() / 1000)}_${Math.random().toString(36).substr(2, 5)}`;
          const prodRef = doc(db, "products", fallbackId);
          await setDoc(prodRef, {
            id: fallbackId,
            name: item.name,
            sku: fallbackId,
            category: "General",
            lowStock: false,
            preferredRepId: selectedRepId,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
          item.matchedProductId = fallbackId;
        }

        // Save Price Log
        const priceRef = doc(collection(db, "prices"));
        const pricePayload: PriceEntry = {
          id: priceRef.id,
          productId: item.matchedProductId,
          repId: selectedRepId,
          price: item.price,
          packSize: `Docket Qty ${item.quantity}`,
          effectiveDate: isNaN(Date.parse(extractedData.invoiceDate)) ? serverTimestamp() : new Date(extractedData.invoiceDate),
          invoiceId: invoiceRecordId,
          createdAt: serverTimestamp(),
          createdBy: currentUserUid
        };

        await setDoc(priceRef, pricePayload);
      }

      // Update invoice as confirmed
      const invoiceDocRef = doc(db, "invoices", invoiceRecordId);
      await updateDoc(invoiceDocRef, {
        status: "confirmed",
        repId: selectedRepId,
        invoiceDate: extractedData.invoiceDate,
        totalAmount: extractedData.totalAmount,
        items: extractedData.items
      });

      setStatus("success");
    } catch (err: any) {
      console.error("Saving confirmed scan failed:", err);
      setStatus("error");
      setErrorMessage(err.message || "Unable to save price history. Try again.");
    }
  };

  return (
    <div className="bg-white rounded-md shadow-2xs border border-slate-200 p-4" id="docket_scanner_root">
      
      {/* HEADER - COMPACT */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-150">
        <div className="flex items-center gap-1.5">
          <Receipt className="h-4 w-4 text-emerald-600" />
          <h2 className="text-sm font-bold text-slate-900">Scan Wholesale Docket</h2>
        </div>
        <div className="flex items-center gap-1 px-2 py-0.5 bg-emerald-50 rounded border border-emerald-110 text-[9px] font-bold text-emerald-800">
          <Sparkles className="h-2.5 w-2.5 animate-pulse" />
          <span>Gemini 3.5 Flash Active</span>
        </div>
      </div>

      {/* STEP: DROPZONE / SELECT */}
      {status === "idle" && (
        <div className="space-y-3" id="docket_step_idle">
          {!file ? (
            <div
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded p-5 flex flex-col items-center justify-center cursor-pointer transition-all ${
                dragActive ? "border-emerald-500 bg-emerald-50/30" : "border-slate-200 hover:border-emerald-555 bg-slate-50/40"
              }`}
              onClick={() => document.getElementById("docket_file_picker")?.click()}
            >
              <FileUp className="h-7 w-7 text-slate-400 mb-2" />
              <p className="text-xs font-bold text-slate-700">Upload Wholesale Docket Photo or PDF</p>
              <p className="text-[10px] text-slate-405 mt-0.5">Drag &amp; drop file here, or click to browse</p>
              <p className="text-[9px] text-slate-400 mt-2">Accepts PDF, JPG, PNG or WEBP (Standard wholesale dockets)</p>
              
              <input
                type="file"
                id="docket_file_picker"
                className="hidden"
                accept="image/*,application/pdf"
                onChange={handleFileChange}
              />
            </div>
          ) : (
            <div className="flex items-center justify-between p-2.5 bg-emerald-50/50 rounded border border-emerald-100/70">
              <div className="flex items-center gap-2">
                <Receipt className="h-6 w-6 text-emerald-600 shrink-0" />
                <div className="text-left font-sans">
                  <p className="text-[11px] font-bold text-slate-800 line-clamp-1">{file.name}</p>
                  <p className="text-[9px] text-slate-500">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setFile(null)}
                  className="px-2 py-1 text-[10px] font-semibold text-slate-500 hover:text-slate-700 cursor-pointer"
                >
                  Clear File
                </button>
                <button
                  onClick={handleStartOCRScan}
                  className="px-2.5 py-1 text-[10px] font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded cursor-pointer flex items-center gap-1 transition-colors"
                >
                  <Sparkles className="h-3 w-3" />
                  <span>Start Gemini Scan</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* STEP: SCANNING PROCESSING */}
      {status === "scanning" && (
        <div className="py-8 flex flex-col items-center justify-center space-y-2.5" id="docket_step_scanning">
          <Loader2 className="h-8 w-8 text-emerald-600 animate-spin" />
          <div className="text-center">
            <h3 className="text-xs font-bold text-slate-800">Gemini reading your docket...</h3>
            <p className="text-[10px] text-slate-405 mt-0.5">Extracting suppliers, items, quantities, and cost prices automatically.</p>
          </div>
          <div className="text-[8px] text-slate-400 font-mono tracking-tight max-w-xs text-center leading-relaxed">
            Supermarket OCR engines optimize wholesale catalogs, preventing overpayment errors in Auckland store visits.
          </div>
        </div>
      )}

      {/* STEP: REVIEW RESULTS VIEW */}
      {status === "review" && extractedData && (
        <div className="space-y-3 text-left" id="docket_step_review">
          
          {/* TOP METRICS SUMMARY */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 p-2.5 bg-slate-50 border border-slate-200 rounded">
            <div className="space-y-0.5">
              <span className="text-[8px] uppercase tracking-wider font-bold text-slate-400">Extracted Supplier</span>
              <input
                type="text"
                className="w-full text-[10px] font-bold bg-white border border-slate-200 p-1 rounded focus:border-emerald-500 focus:outline-none font-sans"
                value={extractedData.supplierName}
                onChange={(e) => setExtractedData({ ...extractedData, supplierName: e.target.value })}
              />
            </div>
            
            <div className="space-y-0.5">
              <span className="text-[8px] uppercase tracking-wider font-bold text-slate-400">Docket Date</span>
              <input
                type="date"
                className="w-full text-[10px] bg-white border border-slate-200 p-1 rounded focus:border-emerald-500 focus:outline-none font-sans"
                value={extractedData.invoiceDate}
                onChange={(e) => setExtractedData({ ...extractedData, invoiceDate: e.target.value })}
              />
            </div>

            <div className="space-y-0.5">
              <span className="text-[8px] uppercase tracking-wider font-bold text-slate-400 font-sans">Assigned Rep Profile</span>
              <select
                className="w-full text-[10px] bg-white border border-slate-200 p-1 rounded focus:border-emerald-500 focus:outline-none font-sans"
                value={selectedRepId}
                onChange={(e) => setSelectedRepId(e.target.value)}
              >
                <option value="">-- No Rep Selected --</option>
                {reps.map(r => (
                  <option key={r.id} value={r.id}>{r.name} ({r.company})</option>
                ))}
              </select>
            </div>

            <div className="space-y-0.5">
              <span className="text-[8px] uppercase tracking-wider font-bold text-slate-400 font-sans">Scanned Grand Total</span>
              <div className="relative">
                <span className="absolute left-1.5 top-1 text-[10px] font-bold text-slate-400">$</span>
                <input
                  type="number"
                  step="0.01"
                  className="w-full text-[10px] font-bold bg-white border border-slate-200 p-1 pl-4 rounded focus:border-emerald-500 focus:outline-none font-mono"
                  value={extractedData.totalAmount}
                  onChange={(e) => setExtractedData({ ...extractedData, totalAmount: parseFloat(e.target.value) || 0 })}
                />
              </div>
            </div>
          </div>

          {/* EXTRACTED ITEMS TABLE */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <h3 className="text-[11px] font-bold text-slate-700 flex items-center gap-1">
                <ShoppingBag className="h-3.5 w-3.5 text-emerald-600" />
                <span>Reviewed Item List</span>
              </h3>
              <p className="text-[9px] text-slate-400">Match with master POS inventory or spawn new products instantly.</p>
            </div>

            <div className="overflow-x-auto border border-slate-150 rounded">
              <table className="w-full text-left text-[10px]">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 font-bold uppercase text-[8px] border-b border-slate-150">
                    <th className="p-1 px-2.5">POS Match / Cross-Ref</th>
                    <th className="p-1 px-2.5">Docket Product Name (OCR)</th>
                    <th className="p-1 px-2 w-24">Barcode</th>
                    <th className="p-1 px-2 w-12 text-center">Qty</th>
                    <th className="p-1 px-2 w-20">Unit Cost ($)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {extractedData.items.map((item, index) => {
                    const matchedProd = products.find(p => p.id === item.matchedProductId);
                    
                    return (
                      <tr key={index} className="hover:bg-slate-50/50">
                        {/* POS MATCH COLUMN */}
                        <td className="p-1 px-2">
                          {matchedProd ? (
                            <div className="flex items-center gap-1 px-1.5 py-0.5 bg-emerald-50 text-emerald-800 rounded font-bold text-[9px] w-fit">
                              <Check className="h-3 w-3 shrink-0" />
                              <span className="line-clamp-1 max-w-[125px]">{matchedProd.name}</span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1">
                              {/* Dropdown to match with existing product */}
                              <select
                                className="text-[9px] p-0.5 bg-amber-50 border border-amber-200 rounded text-amber-900 focus:outline-none"
                                value={item.matchedProductId || ""}
                                onChange={(e) => handleUpdateItemField(index, "matchedProductId", e.target.value)}
                              >
                                <option value="">-- Match product --</option>
                                {products.map(p => (
                                  <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
                                ))}
                              </select>

                              {/* Create product instantly */}
                              <button
                                onClick={() => handleCreateNewProduct(index)}
                                title="Create as a new product in master POS list"
                                className="p-0.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded text-emerald-650 hover:text-emerald-700 cursor-pointer shrink-0"
                              >
                                <Plus className="h-3 w-3" />
                              </button>
                            </div>
                          )}
                        </td>

                        {/* PRODUCT DESCRIPTION EDITABLE */}
                        <td className="p-1 px-2 font-sans">
                          <input
                            type="text"
                            className="bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-emerald-500 focus:ring-0 p-0 text-[10px] font-bold text-slate-800 w-full"
                            value={item.name}
                            onChange={(e) => handleUpdateItemField(index, "name", e.target.value)}
                          />
                        </td>

                        {/* CODES */}
                        <td className="p-1 px-2">
                          <input
                            type="text"
                            className="bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-emerald-500 focus:ring-0 p-0 text-[9px] font-mono text-slate-450 w-full"
                            value={item.code || ""}
                            onChange={(e) => handleUpdateItemField(index, "code", e.target.value)}
                            placeholder="N/A"
                          />
                        </td>

                        {/* QUANTITY */}
                        <td className="p-1 px-2 text-center font-mono">
                          <input
                            type="number"
                            className="bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-emerald-500 focus:ring-0 p-0 text-[10px] text-slate-800 w-full text-center font-bold"
                            value={item.quantity}
                            onChange={(e) => handleUpdateItemField(index, "quantity", parseInt(e.target.value) || 0)}
                          />
                        </td>

                        {/* EACH UNIT COST */}
                        <td className="p-1 px-2">
                          <div className="relative font-mono">
                            <span className="absolute left-0 bottom-0 text-[9px] text-slate-400">$</span>
                            <input
                              type="number"
                              step="0.01"
                              className="bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-emerald-500 focus:ring-0 p-0 pl-2.5 text-[10px] w-full text-left font-bold text-slate-850"
                              value={item.price}
                              onChange={(e) => handleUpdateItemField(index, "price", parseFloat(e.target.value) || 0)}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* BOTTOM SUBMIT COMMANDS */}
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-150">
            <button
              onClick={() => setStatus("idle")}
              className="px-2.5 py-1 border border-slate-200 hover:bg-slate-50 text-slate-650 text-[10px] font-semibold rounded cursor-pointer"
            >
              Back / Upload Again
            </button>
            <button
              onClick={handleConfirmReviewSubmit}
              disabled={reps.length === 0}
              className="px-3 py-1 bg-emerald-700 hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-400 text-white text-[10px] font-bold rounded cursor-pointer flex items-center gap-1 shadow-2xs"
            >
              <UserCheck className="h-3.5 w-3.5" />
              <span>Confirm &amp; Log Prices</span>
            </button>
          </div>
        </div>
      )}

      {/* STEP: SAVING STATE */}
      {status === "saving" && (
        <div className="py-8 flex flex-col items-center justify-center space-y-2.5" id="docket_step_saving">
          <Loader2 className="h-8 w-8 text-emerald-600 animate-spin" />
          <h3 className="text-xs font-bold text-slate-800">Logging New Prices to History...</h3>
          <p className="text-[9px] text-slate-405 max-w-xs text-center leading-tight">Creating individual timeline points per rep per product inside Chapel Downs Supermarket database.</p>
        </div>
      )}

      {/* STEP: SUCCESS */}
      {status === "success" && (
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          className="py-6 text-center space-y-3"
          id="docket_step_success"
        >
          <div className="inline-flex items-center justify-center p-2 bg-emerald-100 rounded-full text-emerald-600">
            <Check className="h-6 w-6 stroke-[3px]" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-slate-900">Docket Processed Successfully</h3>
            <p className="text-[10px] text-slate-500 mt-0.5">Extracted items are now linked. Old wholesale costs are stored forever for negotiations.</p>
          </div>
          <button
            onClick={() => {
              setFile(null);
              setExtractedData(null);
              setStatus("idle");
              onScanConfirmed();
            }}
            className="px-3 py-1 bg-slate-900 hover:bg-slate-800 text-white text-[10px] font-semibold rounded cursor-pointer transition-all"
          >
            Scan Another Docket
          </button>
        </motion.div>
      )}

      {/* STEP: ERROR STATE */}
      {status === "error" && (
        <div className="py-6 text-center space-y-3" id="docket_step_error">
          <div className="inline-flex items-center justify-center p-2 bg-rose-100 rounded-full text-rose-600">
            <AlertCircle className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-rose-955">Docket Scan Interrupted</h3>
            <p className="text-[9px] text-rose-700 max-w-xs mx-auto mt-0.5 leading-normal">{errorMessage}</p>
          </div>
          <div className="flex justify-center gap-2">
            <button
              onClick={() => setStatus("idle")}
              className="px-3 py-1 border border-rose-200 hover:bg-rose-100/30 text-rose-900 text-[10px] font-semibold rounded cursor-pointer"
            >
              Back
            </button>
            <button
              onClick={handleStartOCRScan}
              className="px-3 py-1 bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold rounded cursor-pointer flex items-center gap-1"
            >
              <RefreshCw className="h-3 w-3" />
              <span>Retry Gemini API</span>
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
